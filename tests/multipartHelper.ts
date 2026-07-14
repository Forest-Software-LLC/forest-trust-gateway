/*
    multipartHelper.ts — builds a valid multipart/form-data body by hand for
    tests, so route tests can exercise the real Fastify multipart parsing
    path via fastify.inject() rather than mocking it away.
*/

export function buildMultipartBody(fields: { name: string; value: string | Buffer; filename?: string; contentType?: string }[]) {
    const boundary = `----forestTestBoundary${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];

    for (const field of fields) {
        let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
        if (field.filename) {
            header += `; filename="${field.filename}"`;
        }
        header += '\r\n';
        if (field.contentType) {
            header += `Content-Type: ${field.contentType}\r\n`;
        }
        header += '\r\n';
        parts.push(Buffer.from(header, 'utf8'));
        parts.push(typeof field.value === 'string' ? Buffer.from(field.value, 'utf8') : field.value);
        parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}
