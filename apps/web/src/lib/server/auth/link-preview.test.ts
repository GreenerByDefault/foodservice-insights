import { describe, expect, test } from 'vitest';
import { isLinkPreview } from './link-preview.ts';

describe('isLinkPreview', () => {
  test.each([
    [
      'iMessage',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
    ],
    ['Facebook', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['X', 'Twitterbot/1.0'],
    ['Slack', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
    ['Telegram', 'TelegramBot (like TwitterBot)'],
    [
      'LinkedIn',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    ],
    [
      'Teams',
      'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
    ],
    ['WhatsApp and Signal', 'WhatsApp/2.23.20.0 A'],
  ])('recognizes %s', (_app, userAgent) => {
    expect(isLinkPreview(userAgent)).toBe(true);
  });

  test.each([
    [
      'Safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    ],
    [
      'Chrome',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ],
    [
      "Facebook's in-app browser",
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0]',
    ],
    [
      "Slack's desktop app",
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.97 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36 Slack_SSB/4.41.97',
    ],
    [
      "LinkedIn's in-app browser",
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.0',
    ],
  ])('lets %s through', (_browser, userAgent) => {
    expect(isLinkPreview(userAgent)).toBe(false);
  });

  test('lets through a request with no user agent', () => {
    expect(isLinkPreview(null)).toBe(false);
  });
});
