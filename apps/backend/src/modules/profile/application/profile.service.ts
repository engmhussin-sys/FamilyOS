import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PROFILE_REPOSITORY, type IProfileRepository, type IUpdateProfileInput } from '../domain/profile.types';

@Injectable()
export class ProfileService {
  constructor(@Inject(PROFILE_REPOSITORY) private readonly repository: IProfileRepository) {}

  async getProfile(userId: string) {
    const profile = await this.repository.findById(userId);
    if (!profile) {
      throw new NotFoundException('User not found.');
    }
    return profile;
  }

  updateProfile(userId: string, input: IUpdateProfileInput) {
    return this.repository.update(userId, input);
  }
}
