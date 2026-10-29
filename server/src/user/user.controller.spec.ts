import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { UserController } from './user.controller';
import { UserService } from './user.service';

describe('UserController', () => {
  let controller: UserController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: {} },
        { provide: AuthService, useValue: {} },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

describe('DELETE /users/me', () => {
  it('hands the password to the service, and ends the sessions only once the account is closed', async () => {
    const users = { softDelete: jest.fn(() => Promise.resolve({ id: 'u1' })) };
    const auth = { revokeAllUserTokens: jest.fn(() => Promise.resolve()) };
    const controller = new UserController(users as never, auth as never);

    await expect(controller.deleteAccount({ sub: 'u1', email: 'u1@test.local' }, { password: 'account-password' })).resolves.toEqual({
      message: 'Account deleted.',
    });
    expect(users.softDelete).toHaveBeenCalledWith('u1', 'account-password');
    expect(auth.revokeAllUserTokens).toHaveBeenCalledWith('u1');

    users.softDelete.mockRejectedValueOnce(new Error('That password is not right.'));
    auth.revokeAllUserTokens.mockClear();
    await expect(controller.deleteAccount({ sub: 'u1', email: 'u1@test.local' }, { password: 'guess' })).rejects.toThrow();
    expect(auth.revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('refuses a request without the password before it reaches the service', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    const metadata = { type: 'body' as const, metatype: DeleteAccountDto };

    await expect(pipe.transform({}, metadata)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ password: 7 }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ password: 'x' }, metadata)).resolves.toBeInstanceOf(DeleteAccountDto);
  });

  it('allows a few tries a minute, so the password cannot be guessed through it', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', UserController.prototype.deleteAccount)).toBe(5);
  });
});
