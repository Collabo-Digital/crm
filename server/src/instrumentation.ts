import { config as loadEnvFile } from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter, ParentBasedSampler, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import type { Sampler } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';

// This file runs before AppModule, so ConfigModule has not read .env yet.
loadEnvFile({ quiet: true });

export const SERVICE_NAME = 'crm-api';
/// The Docker healthcheck, which runs every 30 seconds.
const HEALTHCHECK_URL = '/api/v1';
/// Setting these replaces OpenTelemetry's defaults, so its four are repeated
/// here. The rest stop OAuth codes and webhook secrets reaching the collector.
const REDACTED_QUERY_PARAMS = [
    'sig',
    'Signature',
    'AWSAccessKeyId',
    'X-Goog-Signature',
    'code',
    'state',
    'hmac',
    'token',
    'access_token',
    'hub.verify_token',
];

/// How often metrics (event-loop lag, CPU, memory, request latency) are sent.
const METRIC_EXPORT_INTERVAL_MS = 60_000;

/// Traces that start with one of these are background chatter, not work:
/// BullMQ's stalled-job checks run every 30 seconds per queue, and a Prisma
/// query outside any request or job has nothing to explain it.
const DROPPED_ROOT_SPANS = /^(prisma:client:operation|moveStalledJobsToWait |startStalledCheckTimer )/;

/// Prisma's internal steps around each query. The query and its SQL are kept.
const IGNORED_PRISMA_SPANS = [
    'prisma:client:serialize',
    'prisma:engine:connection',
    'prisma:engine:serialize',
    'prisma:engine:response_json_serialization',
];

/// Drops a trace only when its first span is chatter; spans inside a request
/// or job follow their parent, so nothing is cut out of a kept trace.
const backgroundChatterFilter: Sampler = {
    shouldSample: (_context, _traceId, spanName) => ({
        decision: DROPPED_ROOT_SPANS.test(spanName) ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
    }),
    toString: () => 'BackgroundChatterFilter',
};

/// Sends to the collector when one is set, prints to the console in development
/// otherwise, and returns nothing when there is nowhere to send, leaving tracing off.
function createTraceExporter() {
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return new OTLPTraceExporter();

    if (process.env.NODE_ENV === 'development') return new ConsoleSpanExporter();

    return undefined;
}

/// Metrics and logs go only to a collector; nothing is printed in development.
function createMetricReaders() {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return [];

    return [
        new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
        }),
    ];
}

function createLogRecordProcessors() {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return [];

    return [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })];
}

function startTracing() {
    const traceExporter = createTraceExporter();
    if (!traceExporter) return undefined;

    try {
        const sdk = new NodeSDK({
            serviceName: SERVICE_NAME,
            traceExporter,
            sampler: new ParentBasedSampler({ root: backgroundChatterFilter }),
            metricReaders: createMetricReaders(),
            logRecordProcessors: createLogRecordProcessors(),
            instrumentations: [
                getNodeAutoInstrumentations({
                    '@opentelemetry/instrumentation-fs': { enabled: false },
                    // CPU, memory and network for the process and the host (off by default).
                    '@opentelemetry/instrumentation-host-metrics': { enabled: true },
                    '@opentelemetry/instrumentation-dns': { enabled: false },
                    '@opentelemetry/instrumentation-net': { enabled: false },
                    '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
                    '@opentelemetry/instrumentation-http': {
                        ignoreIncomingRequestHook: (request) => request.url === HEALTHCHECK_URL,
                        redactedQueryParams: REDACTED_QUERY_PARAMS,
                        redactedQueryParamsServer: REDACTED_QUERY_PARAMS,
                    },
                }),
                new PrismaInstrumentation({ ignoreSpanTypes: IGNORED_PRISMA_SPANS }),
            ],
        });
        sdk.start();
        return sdk;
    } catch (error) {
        // A tracing failure must never stop the API from starting.
        console.error('Failed to start tracing', error);
        return undefined;
    }
}

const tracingSdk = startTracing();

/// Flushes pending spans. Never throws: Nest would turn a clean shutdown into exit code 1.
export async function shutdownTracing() {
    try {
        await tracingSdk?.shutdown();
    } catch (error) {
        console.error('Failed to shut down tracing', error);
    }
}