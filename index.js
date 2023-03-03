// convert the imports below to use require instead of import

import * as u8a from "uint8arrays";
import { joinSignature } from "@ethersproject/bytes";
import { hashMessage } from "@ethersproject/hash";
import { computeAddress, recoverAddress } from "@ethersproject/transactions";

const CMDS = {
  sign: new Uint8Array([1]),
  listKeys: new Uint8Array([2]),
  generateKey: new Uint8Array([3]),
  readStorage: new Uint8Array([0xd1]),
  writeStorage: new Uint8Array([0xd3]),
};

const toHex = (b) => "0x" + u8a.toString(b, "base16");
const fromHex = (s) => u8a.fromString(s.slice(2), "base16");

export function ethSignMessage(message, slot, address) {
  return ethSignHash(hashMessage(message), slot, address);
}

export async function ethSignHash(hash, slot, address) {
  const sig = await sign(hash, slot);
  const errMsg = "Address provided does not correspond to slot: " + slot;
  return ethJoinSignature(hash, sig, address, errMsg);
}

function ethJoinSignature(hash, sig, address, errMsg) {
  for (let i = 0; i < 2; ++i) {
    sig.recoveryParam = i;
    if (address.toLowerCase() === recoverAddress(hash, sig).toLowerCase()) {
      break;
    } else if (i === 1) {
      throw new Error(errMsg);
    }
  }
  return joinSignature(sig);
}

export async function sign(hash, slot) {
  const bytes = await sendCmd(CMDS.sign, new Uint8Array([slot]), fromHex(hash));
  return toEIP2Signature(unpackDERSignature(bytes));
}

export async function generateKey() {
  const bytes = await sendCmd(CMDS.generateKey);
  if (bytes[0] === 0xe1) {
    if (bytes[1] === 0x06) {
      throw Error("Third key was already generated.");
    } else {
      throw Error("Failed to generate key. Error code: " + toHex(bytes));
    }
  }
}

export async function writeStorage(slot, data) {
  const bytes = await sendCmd(
    CMDS.writeStorage,
    new Uint8Array([slot]),
    fromHex(data)
  );
  throwOnStorageError(bytes);
}

export async function readStorage(slot) {
  const bytes = await sendCmd(CMDS.readStorage, new Uint8Array([slot]));
  throwOnStorageError(bytes);
  return toHex(bytes);
}

function throwOnStorageError(name, bytes) {
  if (bytes.length === 2 && bytes[0] === 0xe1) {
    if (bytes[1] === 0x09) {
      return new Uint8Array();
    } else if (bytes[1] === 0x07) {
      throw Error(name + ": only slot 1 and 2 are allowed");
    } else if (bytes[1] === 0x08) {
      throw Error(name + ": data is already stored in this slot");
    } else {
      throw Error(name + ": failed with error code: " + toHex(bytes));
    }
  }
}

export async function listKeys() {
  const bytes = await sendCmd(CMDS.listKeys);

  const { key: key1, remainder: remainder1 } = readKey(bytes, 1);
  const { key: key2, remainder: remainder2 } = readKey(remainder1, 2);

  const keys = [key1, key2];

  if (remainder2.length) {
    const { key: key3 } = readKey(remainder2, 3);
    keys.push(key3);
  }
  return keys;
}

function readKey(bytes, slot) {
  const length = bytes[0] + 1;
  const key = toHex(bytes.slice(1, length));
  const address = computeAddress(key);
  return {
    key: {
      key,
      slot,
      address,
      did: "did:pkh:eip155:1:" + address.toLowerCase(),
    },
    remainder: bytes.slice(length),
  };
}

export function parseURLParamsWithoutLatch(params) {
  if (!params) return null;
  const { cmd, res, static: staticParams } = params;
  const fromHexUpper = (s) => fromHex("0x" + s.toLowerCase());
  const keyBytes = fromHexUpper(staticParams);
  const { key: key1, remainder: remainder1 } = readKey(keyBytes, 1);
  const { key: key2, remainder: remainder2 } = readKey(remainder1, 2);
  const keys = [key1, key2];
  try {
    const { key: key3 } = readKey(remainder2, 3);
    keys.push(key3);
  } catch (e) {}
  const errMsg = "Signature of key 1 not valid";
  const challenge = "0x" + cmd.toLowerCase().slice(4, 64 + 4);
  const eipSig = toEIP2Signature(unpackDERSignature(fromHexUpper(res)));
  const signature = ethJoinSignature(challenge, eipSig, key1.address, errMsg);
  return {
    keys,
    proof: {
      challenge,
      signature,
      counter: parseInt(challenge.slice(2, 10), 16), // 32-bit BigEndian
    },
  };
}

export function parseURLParams(params) {
  if (!params) return null;
  const fromHexUpper = (s) => fromHex("0x" + s.toLowerCase());
  const parsed = Object.fromEntries(new URLSearchParams(params).entries());
  // public keys
  const keyBytes = fromHexUpper(parsed.static);
  const { key: key1, remainder: remainder1 } = readKey(keyBytes, 1);
  const { key: key2, remainder: remainder2 } = readKey(remainder1, 2);
  const keys = [key1, key2];
  try {
    const { key: key3 } = readKey(remainder2, 3);
    keys.push(key3);
  } catch (e) {}

  // clean up key2 signature
  const errMsg = "Signature of key 2 not valid";
  const challenge = "0x" + parsed.cmd.toLowerCase().slice(4, 64 + 4);
  const eipSig = toEIP2Signature(unpackDERSignature(fromHexUpper(parsed.res)));
  const signature = ethJoinSignature(challenge, eipSig, key2.address, errMsg);

  return {
    tagVersion: "0x" + parsed.v,
    keys,
    proof: {
      challenge,
      signature,
      counter: parseInt(challenge.slice(2, 10), 16), // 32-bit BigEndian
    },
    storage: [
      {
        slot: 1,
        value: "0x" + parsed.latch1.toLowerCase(),
      },
      {
        slot: 2,
        value: "0x" + parsed.latch2.toLowerCase(),
      },
    ],
  };
}

async function sendCmd(cmd, slot, data) {
  let payload;
  if (!slot && !data) {
    payload = cmd;
  } else if (slot && !data) {
    payload = u8a.concat([cmd, slot]);
  } else if (data) {
    payload = u8a.concat([cmd, slot, data]);
  }
  try {
    const req = {
      publicKey: {
        allowCredentials: [
          {
            id: payload,
            transports: ["nfc"],
            type: "public-key",
          },
        ],
        challenge: new Uint8Array([
          113, 241, 176, 49, 249, 113, 39, 237, 135, 170, 177, 61, 15, 14, 105,
          236, 120, 140, 4, 41, 65, 225, 107, 63, 214, 129, 133, 223, 169, 200,
          21, 88,
        ]),
        // rpId: DOMAIN,
        timeout: 60000,
        userVerification: "discouraged",
      },
    };
    const xdd = await navigator.credentials.get(req);
    return new Uint8Array(xdd.response.signature);
  } catch (err) {
    throw Error("Error with scan", err);
  }
}

function unpackDERSignature(sig) {
  const bytes = sig.values();

  if (bytes.next().value !== 0x30) {
    throw Error("Invalid header, " + toHex(sig));
  }
  bytes.next(); // ignore second byte of header

  if (bytes.next().value !== 0x02) {
    throw Error("Invalid header (2).");
  }

  let length_r = bytes.next().value;
  if (length_r == 33) {
    bytes.next(); // ignore prepended padding
    length_r -= 1;
  }
  const r = new Uint8Array(length_r);
  for (let i = 0; i < length_r; ++i) {
    r[i] = bytes.next().value;
  }

  if (bytes.next().value !== 0x02) {
    throw Error("Invalid header (2).");
  }

  let length_s = bytes.next().value;
  if (length_s == 33) {
    bytes.next(); // ignore prepended padding
    length_s -= 1;
  }
  const s = new Uint8Array(length_r);
  for (let i = 0; i < length_s; ++i) {
    s[i] = bytes.next().value;
  }

  return { r, s };
}

function toEIP2Signature({ s, r }) {
  let sNew = BigInt(toHex(s));
  // SECP256k1 order constant
  const curveOrder =
    115792089237316195423570985008687907852837564279074904382605163141518161494337n;

  if (sNew > curveOrder / 2n) {
    // malleable signature, not compliant with Ethereum's EIP-2
    // we need to flip s value in the signature
    sNew = -sNew + curveOrder;
  }
  return {
    r: toHex(r),
    s: "0x" + sNew.toString(16),
  };
}
