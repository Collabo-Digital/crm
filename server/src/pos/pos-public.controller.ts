import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PosBillService } from './pos-bill.service';

/**
 * The bill behind the link a customer is sent: public, because the customer
 * has no login, and limited per address like the other public routes (the
 * global throttle), though the link itself cannot be guessed.
 */
@Controller('public/bills')
export class PosPublicController {
    constructor(private readonly bills: PosBillService) { }

    @Public()
    @Get(':token')
    @Header('Cache-Control', 'no-store')
    @Header('X-Robots-Tag', 'noindex')
    bill(@Param('token') token: string) {
        return this.bills.publicBill(token);
    }
}
