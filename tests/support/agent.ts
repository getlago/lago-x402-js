/** Test agents built only on the official x402 client libraries (`@x402/fetch`,
 * `@x402/evm`, `@x402/extensions`), with throwaway keys from `generatePrivateKey()` and
 * `nacl.sign.keyPair()`. Never a real or funded key. */
import { randomBytes } from "node:crypto";
import type { ClientExtension } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createSIWxClientExtension, encodeBase58, type SolanaSigner } from "@x402/extensions/sign-in-with-x";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface EvmAgent {
  account: PrivateKeyAccount;
  client: x402Client;
  /** The transport layer a stock `wrapFetchWithPayment` drives: decodes `PAYMENT-REQUIRED`,
   * runs extension hooks (sign-in), encodes `PAYMENT-SIGNATURE`. */
  http: x402HTTPClient;
  siwx: ClientExtension;
}

/** A stock EVM agent (references.md recipe). `signIn: false` builds one without the SIWx
 * extension. The stock client refuses any default-asset (USDC) payment above
 * `DEFAULT_MAX_AMOUNT_PER_PAYMENT` ("$1" in @x402/core 2.28.0) unless the agent raises its
 * `spendControls`; pass `maxAmountPerPayment` to model an agent that did. */
export function evmAgent(o: { signIn?: boolean; maxAmountPerPayment?: string | false } = {}): EvmAgent {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));
  const siwx = createSIWxClientExtension({ signers: [account] });
  if (o.signIn ?? true) client.registerExtension(siwx);
  if (o.maxAmountPerPayment !== undefined) {
    client.setSpendControls({ maxAmountPerPayment: o.maxAmountPerPayment });
  }
  return { account, client, http: new x402HTTPClient(client), siwx };
}

/** A wallet-adapter-shaped SIWx `SolanaSigner` (`publicKey` as a base58 string,
 * `signMessage(bytes) → signature bytes`) over a tweetnacl keypair. The secret key stays in
 * the closure. */
export type SolanaTestSigner = SolanaSigner & {
  publicKey: string;
  publicKeyBytes: Uint8Array;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
};

export function solanaSigner(): SolanaTestSigner {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return {
    publicKey: encodeBase58(publicKey),
    publicKeyBytes: publicKey,
    signMessage: async (message: Uint8Array) => nacl.sign.detached(message, secretKey),
  };
}

/** A v2 Solana `exact` payment built by hand, shaped like the stock client's output
 * (`x402Client.createPaymentPayload`: `accepted` is the chosen entry verbatim). The svm
 * client needs an RPC for a recent blockhash, so unit tests never use it; `transaction` is
 * random bytes in base64, shaped like `ExactSvmPayloadV2` but not a real transaction. */
export function solanaPayment(
  accepted: PaymentRequirements,
  extensions?: Record<string, unknown>,
): PaymentPayload {
  return {
    x402Version: 2,
    payload: { transaction: randomBytes(256).toString("base64") },
    ...(extensions === undefined ? {} : { extensions }),
    accepted,
  };
}
