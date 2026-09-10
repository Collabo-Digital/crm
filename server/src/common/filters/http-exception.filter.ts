import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { isRateLimitedError } from '../../rate-limit/rate-limit.types';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(GlobalExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        let statusCode: number;
        let message: string = 'Internal server error';
        let errors: string[] | undefined;

        if (exception instanceof HttpException) {
            statusCode = exception.getStatus();
            const exceptionResponse = exception.getResponse();

            if (typeof exceptionResponse === 'string') {
                message = exceptionResponse;
            } else if (typeof exceptionResponse === 'object') {
                const res = exceptionResponse as Record<string, unknown>;
                message = (res.message as string) || exception.message;

                // class-validator returns an array of error messages
                if (Array.isArray(res.message)) {
                    errors = res.message;
                    message = 'Validation failed';
                }
            }
        } else if (isRateLimitedError(exception)) {
            // The outbound limiter refused a Shopify / Meta call made inside
            // an HTTP request (order edit, draft mirror...). Not our fault and
            // not the caller's: tell them when to try again.
            statusCode = HttpStatus.SERVICE_UNAVAILABLE;
            const retryAfterS = Math.max(1, Math.ceil((exception.retryAtMs - Date.now()) / 1000));
            response.setHeader('Retry-After', String(retryAfterS));
            message = `The connected store is rate limiting us. Try again in ${retryAfterS}s.`;
        } else {
            statusCode = HttpStatus.INTERNAL_SERVER_ERROR;

            // Log the full error internally, never expose to client
            this.logger.error(
                `Unhandled exception on ${request.method} ${request.url}`,
                exception instanceof Error ? exception.stack : String(exception),
            );
        }

        // Build the base error body
        const body: Record<string, unknown> = {
            success: false,
            statusCode,
            message,
            ...(errors && { errors }),
            timestamp: new Date().toISOString(),
            path: request.url,
        };

        // Forward extra fields (e.g. userId, nextStep) from structured exceptions
        if (exception instanceof HttpException) {
            const exceptionResponse = exception.getResponse();
            if (typeof exceptionResponse === 'object' && !Array.isArray(exceptionResponse)) {
                const { statusCode: _, message: __, ...extra } = exceptionResponse as Record<string, unknown>;
                Object.assign(body, extra);
            }
        }

        response.status(statusCode).json(body);
    }
}