import { FptMarketplaceProvider } from './adapters/fpt-marketplace';
import { OpenAiCompatibleProvider } from './adapters/openai-compatible';
import { ShopAIKeyMiniMaxProvider } from './adapters/shopaikey-minimax';
import { ShopAIKeyOpenAiProvider } from './adapters/shopaikey-openai';
import { SonioxTtsProvider } from './adapters/soniox-tts';
import type { TtsProviderType } from '../schemas/common';
import type { TtsProvider } from './types';

const REGISTRY: Record<TtsProviderType, TtsProvider> = {
  fpt_marketplace: new FptMarketplaceProvider(),
  shopaikey_openai: new ShopAIKeyOpenAiProvider(),
  shopaikey_minimax: new ShopAIKeyMiniMaxProvider(),
  openai_compatible: new OpenAiCompatibleProvider(),
  soniox: new SonioxTtsProvider(),
};

/** Registry theo `type`; ứng dụng chỉ biết giao diện TtsProvider (Constitution: adapter nhà cung cấp). */
export function getProvider(type: TtsProviderType): TtsProvider {
  return REGISTRY[type];
}

export * from './types';
export * from './errors';
export * from './catalog';
