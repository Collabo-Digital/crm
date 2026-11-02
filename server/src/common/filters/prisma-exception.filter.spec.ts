import type { ArgumentsHost } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaExceptionFilter } from './prisma-exception.filter';

function run(code: string) {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'POST', url: '/api/v1/inbox/x' }) }) } as unknown as ArgumentsHost;
    new PrismaExceptionFilter().catch(new PrismaClientKnownRequestError('boom', { code, clientVersion: '6' }), host);
    return response;
}

describe('PrismaExceptionFilter', () => {
    it.each(['P2024', 'P2028'])('answers %s (no database connection in time) with 503 and Retry-After', (code) => {
        const res = run(code);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'The server is busy right now. Please try again in a few seconds.' }));
    });

    it('still answers unknown codes with 500', () => {
        expect(run('P2010').status).toHaveBeenCalledWith(500);
    });
});
