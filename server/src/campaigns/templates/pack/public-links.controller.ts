import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../../../auth/decorators/public.decorator';
import { PublicLinksService } from './public-links.service';

/**
 * Behind the app's `/t/<token>` (an order) and `/c/<token>` (a cart) pages,
 * which the pack's message buttons open. Public, and limited per address
 * like the bill links (the global throttle), though a link cannot be guessed.
 */
@Controller('public/links')
export class PublicLinksController {
    constructor(private readonly links: PublicLinksService) { }

    @Public()
    @Get('order/:token')
    @Header('Cache-Control', 'no-store')
    @Header('X-Robots-Tag', 'noindex')
    order(@Param('token') token: string) {
        return this.links.order(token);
    }

    @Public()
    @Get('cart/:token')
    @Header('Cache-Control', 'no-store')
    @Header('X-Robots-Tag', 'noindex')
    cart(@Param('token') token: string) {
        return this.links.cart(token);
    }
}
