import { HttpException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'events';
import http from 'http';
import type { AddressInfo } from 'net';
import Redis from 'ioredis';
import { firstValueFrom, Subscription, take, toArray } from 'rxjs';
import { InboxController } from '../inbox/inbox.controller';
import { InboxService } from '../inbox/inbox.service';
import { InboxTeamService } from '../inbox/inbox-team.service';
import { UploadQuotaService } from './media/upload-quota';
import { InboxEventsService, MAX_STREAMS_PER_USER } from './inbox-events.service';

/** Redis connections, counted; PUBLISH reaches the connections subscribed to the channel. */
jest.mock('ioredis', () => {
  class FakeRedis extends EventEmitter {
    static instances: FakeRedis[] = [];
    readonly channels = new Set<string>();
    readonly calls: string[] = [];
    constructor() {
      super();
      FakeRedis.instances.push(this);
    }
    subscribe(channel: string) {
      this.calls.push(`subscribe ${channel}`);
      this.channels.add(channel);
      return Promise.resolve(1);
    }
    unsubscribe(channel: string) {
      this.calls.push(`unsubscribe ${channel}`);
      this.channels.delete(channel);
      return Promise.resolve(0);
    }
    publish(channel: string, message: string) {
      for (const r of FakeRedis.instances) if (r.channels.has(channel)) r.emit('message', channel, message);
      return Promise.resolve(1);
    }
    disconnect() { }
  }
  return { __esModule: true, default: FakeRedis };
});

type Fake = { channels: Set<string>; calls: string[] };
const fakes = () => (Redis as unknown as { instances: Fake[] }).instances;
const subscribers = () => fakes().filter((r) => r.calls.some((c) => c.startsWith('subscribe')));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function service() {
  fakes().length = 0;
  return new InboxEventsService({ get: () => 'redis://fake' } as never);
}

describe('InboxEventsService — live streams', () => {
  it('serves every stream on the server from one subscriber connection', async () => {
    const events = service();
    const received: Record<string, unknown[]> = { a1: [], a2: [], a3: [], b1: [] };
    const subs: Subscription[] = [
      events.stream('org_a', 'u1').subscribe((e) => received.a1.push(e)),
      events.stream('org_a', 'u2').subscribe((e) => received.a2.push(e)),
      events.stream('org_a', 'u3').subscribe((e) => received.a3.push(e)),
      events.stream('org_b', 'u4').subscribe((e) => received.b1.push(e)),
    ];
    await tick();

    events.publish('org_a', { type: 'conversation.updated', conversationId: 'c1' });
    await tick();

    // One subscriber connection plus the publisher, however many streams.
    expect(subscribers()).toHaveLength(1);
    expect(fakes()).toHaveLength(2);
    expect(subscribers()[0].calls).toEqual(['subscribe crm:inbox:org_a', 'subscribe crm:inbox:org_b']);
    expect([received.a1, received.a2, received.a3].map((r) => r.length)).toEqual([1, 1, 1]);
    expect(received.b1).toEqual([]);

    // The organization is let go of when its last stream closes.
    subs.slice(0, 3).forEach((s) => s.unsubscribe());
    expect(subscribers()[0].calls).toContain('unsubscribe crm:inbox:org_a');
    events.publish('org_b', { type: 'conversation.updated', conversationId: 'c2' });
    await tick();
    expect(received.b1).toHaveLength(1);
    subs[3].unsubscribe();
  });

  it(`lets one member hold ${MAX_STREAMS_PER_USER} streams, refuses the next with a 429, and frees a place when one closes`, async () => {
    const events = service();
    const open = Array.from({ length: MAX_STREAMS_PER_USER }, () => events.stream('org_a', 'u1').subscribe());

    const refused = await firstValueFrom(events.stream('org_a', 'u1')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    const errors: unknown[] = [];
    // Someone else is not affected.
    const other = events.stream('org_a', 'u2').subscribe({ error: (e: unknown) => errors.push(e) });

    open[0].unsubscribe();
    const again = events.stream('org_a', 'u1').subscribe({ error: (e: unknown) => errors.push(e) });

    expect(errors).toEqual([]);
    [...open.slice(1), other, again].forEach((s) => s.unsubscribe());
  });

  it('still delivers events in order to a stream', async () => {
    const events = service();
    const got = firstValueFrom(events.stream('org_a', 'u1').pipe(take(2), toArray()));
    await tick();
    events.publish('org_a', { type: 'message.created', conversationId: 'c1', messageId: 'm1' });
    events.publish('org_a', { type: 'message.updated', conversationId: 'c1', messageId: 'm1' });

    expect((await got).map((e) => e.type)).toEqual(['message.created', 'message.updated']);
  });
});

describe('GET /inbox/stream', () => {
  let app: INestApplication;
  let port: number;
  const requests: http.ClientRequest[] = [];

  beforeAll(async () => {
    fakes().length = 0;
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        InboxEventsService,
        { provide: InboxService, useValue: {} },
        { provide: InboxTeamService, useValue: { touchPresence: () => Promise.resolve() } },
        { provide: UploadQuotaService, useValue: {} },
      ],
    })
      .overrideProvider(InboxEventsService)
      .useValue(new InboxEventsService({ get: () => 'redis://fake' } as never))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 'u1', orgId: 'org_a' };
      next();
    });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    requests.forEach((r) => r.destroy());
    await app.close();
  });

  /** Opens a stream and resolves with its status once the response starts. */
  const open = () =>
    new Promise<{ status: number; body: Promise<string> }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/inbox/stream' }, (res) => {
        const body = new Promise<string>((done) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => done(text));
        });
        resolve({ status: res.statusCode ?? 0, body });
      });
      req.on('error', reject);
      requests.push(req);
    });

  it('answers the stream past the limit with a 429 the client backs off from, and opens again once one closes', async () => {
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) expect((await open()).status).toBe(200);

    const refused = await open();
    expect(refused.status).toBe(429);
    expect(await refused.body).toContain('Too many live inbox connections');

    requests[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await open()).status).toBe(200);
  });

  it('is limited per member a minute instead of skipping the throttle', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', InboxController.prototype.stream)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', InboxController.prototype.stream)).toBe(30);
  });
});
