import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from '../user/user.service';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { DeleteOrganizationDto } from './dto/delete-organization.dto';

describe('OrganizationController', () => {
  let controller: OrganizationController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [
        { provide: OrganizationService, useValue: {} },
        { provide: UserService, useValue: {} },
      ],
    }).compile();

    controller = module.get<OrganizationController>(OrganizationController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

describe('DELETE /organizations/:orgId', () => {
  it("hands the owner's password and the typed name to the service", async () => {
    const orgs = { delete: jest.fn(() => Promise.resolve({ message: 'Organization deleted' })) };
    const controller = new OrganizationController(orgs as never, {} as never);
    const confirm = { password: 'owner-password', confirmName: 'Acme' };

    await controller.delete('org-a', { sub: 'u1', email: 'o@test.local' }, confirm);

    expect(orgs.delete).toHaveBeenCalledWith('org-a', 'u1', confirm);
  });

  it('refuses a request without them before it reaches the service', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    const metadata = { type: 'body' as const, metatype: DeleteOrganizationDto };

    await expect(pipe.transform({}, metadata)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ password: 'x', confirmName: 'Acme' }, metadata)).resolves.toBeInstanceOf(DeleteOrganizationDto);
  });

  it('allows a few tries a minute, so the password cannot be guessed through it', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', OrganizationController.prototype.delete)).toBe(5);
  });
});
