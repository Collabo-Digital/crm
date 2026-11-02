import { firstValueFrom, interval, takeUntil, toArray } from 'rxjs';
import { InboxEventsService } from './inbox-events.service';

describe('InboxEventsService shutdown', () => {
    it('ends open streams on shutdown, and streams opened afterwards at once', async () => {
        const events = new InboxEventsService({ get: () => 'redis://127.0.0.1:1' } as any);
        const open = firstValueFrom(interval(5).pipe(takeUntil(events.closing$), toArray()));
        await new Promise((r) => setTimeout(r, 20));
        await events.onModuleDestroy();
        expect((await open).length).toBeGreaterThan(0);
        const late = await firstValueFrom(interval(5).pipe(takeUntil(events.closing$), toArray()));
        expect(late).toEqual([]);
    });
});
