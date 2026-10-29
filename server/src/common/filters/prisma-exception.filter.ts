import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { Request, Response } from 'express';

@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(PrismaExceptionFilter.name);

    catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        let statusCode: number;
        let message: string = 'An unexpected database error occurred';

        switch (exception.code) {
            // Unique constraint violation
            case 'P2002': {
                statusCode = HttpStatus.CONFLICT;
                // `meta.target` is a string[] of model field names for indexes
                // declared in schema.prisma, but a BARE STRING (the raw
                // constraint name) for indexes Prisma doesn't know about —
                // which is every partial unique index we ship in SQL
                // migrations (orders_channel_id_order_number_manual_key,
                // invoices_order_id_active_key). Calling .join() on the string
                // form throws inside this filter and escapes as a 500, hiding
                // the 409 those constraints exist to produce.
                const target = exception.meta?.target;
                const fields = Array.isArray(target)
                    ? target.join(', ')
                    : typeof target === 'string' && target.length > 0
                        ? target
                        : 'field';
                message = `A record with this ${fields} already exists`;
                break;
            }

            // Record not found
            case 'P2025': {
                statusCode = HttpStatus.NOT_FOUND;
                message = 'The requested resource was not found';
                break;
            }

            // Foreign key constraint failed
            case 'P2003': {
                statusCode = HttpStatus.BAD_REQUEST;
                const field = (exception.meta?.field_name as string) || 'reference';
                message = `Related resource not found: ${field}`;
                break;
            }

            // Required record not found for relation
            case 'P2018': {
                statusCode = HttpStatus.NOT_FOUND;
                message = 'Required related resource not found';
                break;
            }

            // Transaction write conflict / deadlock (Postgres 40001). Transient:
            // the caller's retry budget is already spent by the time this
            // surfaces, so tell the client it is safe to try again rather than
            // reporting an opaque 500.
            case 'P2034': {
                statusCode = HttpStatus.CONFLICT;
                message =
                    'The operation conflicted with a concurrent request. Please try again.';
                break;
            }

            // No free database connection in time (pool timeout, or a
            // transaction that could not start). Transient: retrying shortly works.
            case 'P2024':
            case 'P2028': {
                statusCode = HttpStatus.SERVICE_UNAVAILABLE;
                message = 'The server is busy right now. Please try again in a few seconds.';
                response.setHeader('Retry-After', '5');
                this.logger.warn(`Database busy (${exception.code}) on ${request.method} ${request.url}`);
                break;
            }

            default: {
                statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
                message = 'An unexpected database error occurred';
                this.logger.error(
                    `Unhandled Prisma error ${exception.code} on ${request.method} ${request.url}`,
                    exception.message,
                );
            }
        }

        response.status(statusCode).json({
            success: false,
            statusCode,
            message,
            timestamp: new Date().toISOString(),
            path: request.url,
        });
    }
}