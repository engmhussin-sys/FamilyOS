import { IsEmail, IsIn } from 'class-validator';

export class InviteMemberDto {
  @IsEmail()
  email!: string;

  @IsIn(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'GUEST'])
  role!: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'GUEST';
}
