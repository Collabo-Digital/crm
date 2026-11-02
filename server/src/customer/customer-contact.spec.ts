import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerService } from './customer.service';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/**
 * Editing a customer's phone and address from the customer page. The phone is
 * what Send Message and the order page's WhatsApp button start a chat on, so
 * it is saved in one shape (E.164) and refused when it is not a number.
 */

function build(saved: Record<string, unknown> = {}) {
  const customer = { id: 'cust1', vipLevel: 'NONE', defaultAddress: null, ...saved };
  const prisma = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(customer),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...customer, ...data })),
    },
    customerActivityLog: { create: jest.fn() },
  };
  return { service: new CustomerService(prisma as any, {} as any), prisma };
}

const dataOf = (prisma: ReturnType<typeof build>['prisma']) => prisma.customer.update.mock.calls[0][0].data;

const ADDRESS = {
  first_name: 'Meera',
  address1: '12 MG Road',
  city: 'Pune',
  province: 'Maharashtra',
  stateCode: '27',
  zip: '411001',
  country: 'India',
  country_code: 'IN',
};

describe('CustomerService.update — phone and address', () => {
  it('saves a number typed the Indian way as E.164', async () => {
    const { service, prisma } = build();
    await service.update('cust1', 'org1', 'user1', { phone: '98765 43210' });

    expect(dataOf(prisma).phone).toBe('+919876543210');
  });

  it('reads the number with the country of the saved address', async () => {
    const { service, prisma } = build({ defaultAddress: { country_code: 'GB' } });
    await service.update('cust1', 'org1', 'user1', { phone: '07911 123456' });

    expect(dataOf(prisma).phone).toBe('+447911123456');
  });

  it('refuses something that is not a phone number', async () => {
    const { service, prisma } = build();

    await expect(service.update('cust1', 'org1', 'user1', { phone: '12345' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('clears the phone when it is emptied', async () => {
    const { service, prisma } = build({ phone: '+919876543210' });
    await service.update('cust1', 'org1', 'user1', { phone: '' });

    expect(dataOf(prisma).phone).toBeNull();
  });

  it('saves the address trimmed, without empty fields', async () => {
    const { service, prisma } = build();
    await service.update('cust1', 'org1', 'user1', {
      defaultAddress: { ...ADDRESS, city: ' Pune ', address2: '  ' },
    });

    expect(dataOf(prisma).defaultAddress).toEqual(ADDRESS);
  });

  it('refuses an Indian PIN code that is not 6 digits', async () => {
    const { service } = build();

    await expect(
      service.update('cust1', 'org1', 'user1', { defaultAddress: { ...ADDRESS, zip: '4110' } }),
    ).rejects.toThrow('6 digits');
  });

  it('leaves phone and address alone when an edit does not touch them', async () => {
    const { service, prisma } = build();
    await service.update('cust1', 'org1', 'user1', { tags: ['vip'] });

    expect(dataOf(prisma)).toEqual({ tags: ['vip'] });
  });
});

describe('UpdateCustomerDto — address', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(UpdateCustomerDto, body))).flatMap((e) => [
      e.property,
      ...(e.children ?? []).map((c) => `${e.property}.${c.property}`),
    ]);

  it('needs a first line, a city and a PIN code', async () => {
    const errors = await errorsFor({ defaultAddress: { first_name: 'Meera' } });

    expect(errors).toEqual(
      expect.arrayContaining(['defaultAddress.address1', 'defaultAddress.city', 'defaultAddress.zip']),
    );
  });

  it('accepts a complete address and a cleared phone', async () => {
    expect(await errorsFor({ defaultAddress: ADDRESS, phone: null })).toEqual([]);
  });
});
