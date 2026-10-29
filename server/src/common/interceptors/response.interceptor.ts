import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
    success: boolean;
    data: T;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<ApiResponse<T>> {
        // Server-sent events are written by Nest frame by frame; wrapping each
        // event would drop its `type`.
        if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
            return next.handle() as Observable<ApiResponse<T>>;
        }
        return next.handle().pipe(
            map((data) => ({
                success: true,
                data: data as T,
            })),
        );
    }
}