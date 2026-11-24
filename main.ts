// Tiny stack VM for make.fun's tiny-stack-vm-01 (ISA version 1).
// One run answers a whole set: for every id it reads
// /input/<id>/program.bin and /input/<id>/input.bin and writes
// /output/<id>/stdout.bin and /output/<id>/exit.txt.
// Run as: node main.ts
// (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the directories.)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode table: byte -> (immediate bytes) | (pops << 3) | (pushes << 6).
// The machine: 32-bit wrapping values, a 256-value data stack, a 64-deep
// call stack, 256 words of memory, at most 1,000,000 steps, 65,536 output
// bytes. A trap ends the program at once with the trap's code as the exit
// code, keeping whatever output was written before it.
const T: (number | undefined)[] = new Array(256);
for (const [b, imm, pops, pushes] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
]) T[b] = imm | (pops << 3) | (pushes << 6);

const enc = new TextEncoder();

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const S = new Int32Array(256); // data stack
  let sp = 0;
  const R = new Int32Array(64); // return addresses
  let rp = 0;
  const M = new Int32Array(256); // memory, all zero at the start
  const out = new Uint8Array(65536);
  let olen = 0;
  let ip = 0;
  let pc = 0;
  let steps = 0;
  const end = (code: number) => ({ out: out.slice(0, olen), code });
  for (;;) {
    if (steps === 1000000) return end(10); // step limit
    if (pc < 0 || pc >= n) return end(9); // pc outside the program
    const op = p[pc];
    const t = T[op];
    if (t === undefined) return end(5); // unknown opcode
    const imm = t & 7;
    if (pc + imm >= n) return end(9); // immediate cut off by the end
    steps++;
    const nx = pc + 1 + imm;
    const pops = (t >> 3) & 7;
    const pushes = (t >> 6) & 7;
    if (sp < pops) return end(2); // stack underflow
    if (sp - pops + pushes > 256) return end(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: S[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: S[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: S[sp] = S[sp - 1]; sp++; break; // DUP
      case 0x05: { const x = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = x; break; } // SWAP
      case 0x06: S[sp] = S[sp - 2]; sp++; break; // OVER
      case 0x07: { const x = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = x; break; } // ROT
      case 0x17: S[sp - 1] = (-S[sp - 1]) | 0; break; // NEG, wraps
      case 0x1b: S[sp - 1] = ~S[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let go = op === 0x30;
        if (!go) { const v = S[--sp]; go = op === 0x31 ? v === 0 : v !== 0; }
        if (go) pc = nx + rel;
        break;
      }
      case 0x33:
        if (rp === 64) return end(7); // call stack full
        R[rp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (rp === 0) return end(8); // RET with nowhere to return to
        pc = R[--rp];
        break;
      case 0x40: {
        const a = S[sp - 1];
        if (a < 0 || a > 255) return end(6);
        S[sp - 1] = M[a];
        break;
      }
      case 0x41: {
        const a = S[sp - 1];
        const v = S[sp - 2];
        if (a < 0 || a > 255) return end(6);
        sp -= 2;
        M[a] = v;
        break;
      }
      case 0x50: {
        const b = enc.encode(String(S[sp - 1]));
        if (olen + b.length > 65536) return end(11); // output limit
        sp--;
        out.set(b, olen);
        olen += b.length;
        break;
      }
      case 0x51:
        if (olen + 1 > 65536) return end(11);
        out[olen++] = S[--sp] & 255;
        break;
      case 0x52: S[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN, -1 past the end
      case 0x53: return end(S[--sp] & 255); // EXIT
      default: {
        // Two-operand arithmetic, logic and compare: ( a b -- r ), b on top.
        const b = S[sp - 1];
        const a = S[sp - 2];
        let r = 0;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break; // low 32 bits of the exact product
          case 0x13: if (b === 0) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break;
          case 0x14: if (b === 0) return end(4); r = b === -1 ? 0 : (a % b) | 0; break;
          case 0x15: if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break; // unsigned quotient, read back signed
          case 0x16: if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; break; // unsigned remainder, read back signed
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break; // arithmetic shift
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // logical shift, read back signed
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // 0x22 LTU
        }
        sp -= 2;
        S[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
