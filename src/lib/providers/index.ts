import { FptMarketplaceProvider } from './adapters/fpt-marketplace';
import { ShopAIKeyMiniMaxProvider } from './adapters/shopaikey-minimax';
import { ShopAIKeyOpenAiProvider } from './adapters/shopaikey-openai';
import type { ProviderType, TtsProvider } from './types';

const REGISTRY: Record<ProviderType, TtsProvider> = {
  fpt_marketplace: new FptMarketplaceProvider(),
  shopaikey_openai: new ShopAIKeyOpenAiProvider(),
  shopaikey_minimax: new ShopAIKeyMiniMaxProvider(),
};

/** Registry theo `type`; ứng dụng chỉ biết giao diện TtsProvider (Constitution: adapter nhà cung cấp). */
export function getProvider(type: ProviderType): TtsProvider {
  return REGISTRY[type];
}

export * from './types';
export * from './errors';
export * from './catalog';
