import { registerAs } from '@nestjs/config';

export default registerAs('mail', () => ({
  host: process.env.MAIL_HOST || 'mailpit',
  port: parseInt(process.env.MAIL_PORT || '1025', 10),
  from: `"StreamTube" <${process.env.MAIL_FROM || 'noreply@streamtube.com'}>`,
}));
