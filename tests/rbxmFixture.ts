/*
    Minimal spec-built rbxm fixture: one class, one root instance,
    uncompressed chunks. Parser correctness is tested in
    forest-shared-resources.
*/

function u32(n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
}

function encodeReferents(values: number[]) {
    const deltas = values.map((v, i) => (i === 0 ? v : (v - values[i - 1]) | 0));
    const transformed = deltas.map((d) => ((d << 1) ^ (d >> 31)) >>> 0);
    const n = values.length;
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        out[i] = (transformed[i] >>> 24) & 0xff;
        out[n + i] = (transformed[i] >>> 16) & 0xff;
        out[2 * n + i] = (transformed[i] >>> 8) & 0xff;
        out[3 * n + i] = transformed[i] & 0xff;
    }
    return out;
}

function chunk(name: string, body: Buffer) {
    const nameBuf = Buffer.alloc(4);
    nameBuf.write(name, 'latin1');
    return Buffer.concat([nameBuf, u32(0), u32(body.length), Buffer.alloc(4), body]);
}

export function buildRbxm(className: string): Buffer {
    const classBuf = Buffer.from(className, 'utf8');
    return Buffer.concat([
        Buffer.from('<roblox!', 'ascii'),
        Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
        u32(1), u32(1), Buffer.alloc(8),
        chunk('INST', Buffer.concat([u32(0), u32(classBuf.length), classBuf, Buffer.from([0]), u32(1), encodeReferents([0])])),
        chunk('PRNT', Buffer.concat([Buffer.from([0]), u32(1), encodeReferents([0]), encodeReferents([-1])])),
        chunk('END\0', Buffer.from('</roblox>', 'ascii')),
    ]);
}
