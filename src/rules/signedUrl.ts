/*
    signedUrl.ts

    Signs the short-lived URLs that authorize downloading a private package
    from the CDN. Forest's CDN worker independently verifies this exact
    signature over `${pathname}?expires=${expires}`, so both sides must stay
    in sync — sign only the pathname, never the host.

    The signing key is a parameter, not read from the environment: this
    module has no opinion about where the key comes from, so it can be
    tested (and audited) without any of Forest's configuration.
*/

import { createHmac } from 'crypto';

export function generateSignedUrl(fileUrl: string, signingKey: string, expiresInSec = 300): string {
    const expires = Math.floor(Date.now() / 1000) + expiresInSec;
    const { pathname } = new URL(fileUrl);
    const signature = createHmac('sha256', signingKey)
        .update(`${pathname}?expires=${expires}`)
        .digest('hex');
    return `${fileUrl}?expires=${expires}&signature=${signature}`;
}
