import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { UserService } from './user.service';
import { UserController } from './user.controller';

// ChannelModule: closing an influencer's account disconnects their Instagram.
// Nothing it imports reaches back to this module.
@Module({
  imports: [ChannelModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule { }