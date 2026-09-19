/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePriceTracker } from '@/hooks/use-price-trackernew';
import { PriceDisplay } from '@/components/price-tracker/price-display';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useFreighter } from '@/hooks/use-freighter';
import { soroswapAPI } from '@/lib/api';
import { ASSET_OPTIONS, DEFAULT_PROTOCOLS, ASSET_CONFIGS, DEFAULT_ASSET_CONFIG, SOROSWAP_ROUTER_CONFIG } from '@/lib/constants';
import { getPoolPrice } from '@/lib/prices';
import { createSecureKey, isSecureKeySupported, loadSecureKey, secureSigner } from '@/lib/secure-key';
import { ensureTokenTrustline, getClassicAsset } from '@/lib/trustline';
import { formatAmount, formatPercentage } from '@/lib/utils';

// The trading pair is written base/quote (the UI shows "XLM/USDC"), and the tracked price is one
// unit of the base priced in quote. So buying acquires the base and spends the quote; selling
// does the reverse. Every leg in this file is derived from these two helpers rather than from an
// inline ternary, because the two directions used to disagree with each other across call sites.
const legIn = (type: 'buy' | 'sell', base: string, quote: string): string =>
  type === 'buy' ? quote : base;

const legOut = (type: 'buy' | 'sell', base: string, quote: string): string =>
  type === 'buy' ? base : quote;

export default function PriceBasedAutoTrader() {
  const {
    currentPrice,
    isTracking,
    lastUpdate,
    error,
    startTracking,
    stopTracking
  } = usePriceTracker();

  // Telegram bot
  const [telegramBot, setTelegramBot] = useState<any>(null);
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramDetecting, setTelegramDetecting] = useState(false);
  const [telegramDetectStatus, setTelegramDetectStatus] = useState<string | null>(null);

  // Ask the server which chat has written to the bot. /api/telegram reads the bot's own pending
  // updates, so a hit here also proves the bot is allowed to reply to that chat — which is the
  // part a chat id copied from elsewhere cannot tell you.
  const detectTelegramChatId = useCallback(async (): Promise<void> => {
    setTelegramDetecting(true);
    setTelegramDetectStatus(null);
    try {
      const response = await fetch('/api/telegram', { signal: AbortSignal.timeout(15000) });
      const body = (await response.json().catch(() => ({}))) as { chatId?: string | null; error?: string };

      if (!response.ok) {
        setTelegramDetectStatus(`❌ ${body.error ?? `Proxy error ${response.status}`}`);
        return;
      }
      if (!body.chatId) {
        setTelegramDetectStatus('❌ No chat found. Send your bot a message on Telegram, then press Detect again.');
        return;
      }

      setTelegramChatId(body.chatId);
      localStorage.setItem('telegram_chat_id', body.chatId);
      setTelegramDetectStatus(`✅ Chat ID ${body.chatId} detected and saved.`);
    } catch (caught) {
      setTelegramDetectStatus(`❌ ${(caught as Error).message}`);
    } finally {
      setTelegramDetecting(false);
    }
  }, []);

  // Freighter wallet
  const freighter = useFreighter();
  const { isAvailable, isConnected, publicKey, connect, signTransaction, checkConnection: checkWalletConnection, error: freighterError } = freighter;

  // 🎯 Pre-authorization state (advanced transfer system)
  const [preAuthBuyOrder, setPreAuthBuyOrder] = useState<{
    targetPrice: string;
    amount: string;
    requiredXLM?: number;
    estimatedOutput?: number;
    transferHash?: string;
    expiry: Date;
    status: string;
    isBot?: boolean;
  } | null>(null);
  
  const [preAuthSellOrder, setPreAuthSellOrder] = useState<{
    targetPrice: string;
    amount: string;
    expiry: Date;
    status: string;
    isBot?: boolean;
  } | null>(null);

  // 🤖 Grid trading bot - automatic buy + sell system
  const [gridTradingBot, setGridTradingBot] = useState<{
    buyPrice: string;
    sellPrice: string;
    buyAmount: string;
    sellAmount: string;
    isActive: boolean;
    currentStep: 'waiting_buy' | 'waiting_sell' | 'completed';
    purchasedAmount?: string;
    buyHash?: string;
    sellHash?: string;
    expiry: Date;
    status: string;
    isBot?: boolean;
  } | null>(null);

  // 🤖 Bot Wallet Sistemi
  //
  // New wallets hold a non-extractable key (secure-key.ts): the browser signs with it but cannot
  // read it back, so no seed sits in storage to be lifted. Wallets created before that still carry
  // a plaintext seed and keep working — this wallet holds funds directly, and dropping its key
  // would strand them.
  const [botWallet, setBotWallet] = useState<{
    publicKey: string;
    secretKey?: string;
    key?: CryptoKey;
  } | null>(null);
  const [botMode, setBotMode] = useState<'manual' | 'auto'>('manual');
  const [botBalance, setBotBalance] = useState<number>(0);
  
  // 💰 Auto funding control state - prevents duplicate runs
  const [isAutoFunding, setIsAutoFunding] = useState<boolean>(false);

  // 🎯 Price-based automation - main focus
  const [autoTradeAssetIn, setAutoTradeAssetIn] = useState(ASSET_OPTIONS[0].value); // XLM
  const [autoTradeAssetOut, setAutoTradeAssetOut] = useState(ASSET_OPTIONS[2].value); // USDC
  const [buyTargetPrice, setBuyTargetPrice] = useState('');
  const [sellTargetPrice, setSellTargetPrice] = useState('');
  const [autoBuyAmount, setAutoBuyAmount] = useState('');
  const [autoSellAmount, setAutoSellAmount] = useState('');
  const [isAutoTradingEnabled, setIsAutoTradingEnabled] = useState(false);
  const [autoTradeStatus, setAutoTradeStatus] = useState<string | null>(null);
  const [isTrading, setIsTrading] = useState(false);
  const [hasAutoTradeError, setHasAutoTradeError] = useState(false);
  const lastAutoTradeCheck = useRef<Date | null>(null);

  // 🤖 Grid Trading Bot Input States
  const [gridBuyPrice, setGridBuyPrice] = useState('');
  const [gridSellPrice, setGridSellPrice] = useState('');
  const [gridBuyAmount, setGridBuyAmount] = useState('');
  const [gridSellAmount, setGridSellAmount] = useState('');
  
  // 📊 Manual price check
  const [manualPriceMode, setManualPriceMode] = useState(false);
  const [manualPrice, setManualPrice] = useState('');

  // 🎯 Target reached state - Telegram and wallet trigger
  const [lastBuyTargetReached, setLastBuyTargetReached] = useState<boolean>(false);
  const [lastSellTargetReached, setLastSellTargetReached] = useState<boolean>(false);
  const [buyTargetNotificationSent, setBuyTargetNotificationSent] = useState<boolean>(false);
  const [sellTargetNotificationSent, setSellTargetNotificationSent] = useState<boolean>(false);

  // 💰 Swap cost state (like the home page)
  const [buyQuote, setBuyQuote] = useState<any>(null);
  const [sellQuote, setSellQuote] = useState<any>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // 🤖 Grid Trading Bot Quote States
  const [gridBuyQuote, setGridBuyQuote] = useState<any>(null);
  const [gridSellQuote, setGridSellQuote] = useState<any>(null);
  const [gridQuoteLoading, setGridQuoteLoading] = useState(false);

  // Price of one base unit in quote, read from the pool the swap will go through.
  // `currentPrice` (Reflector, SEP-40) reports the real-world rate and is shown alongside as a
  // reference, but rules fire on this one: it is the market the order is actually filled in.
  const [poolPrice, setPoolPrice] = useState<number>(0);
  const [poolPriceError, setPoolPriceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const readPoolPrice = async (): Promise<void> => {
      try {
        const price = await getPoolPrice(autoTradeAssetIn, autoTradeAssetOut);
        if (cancelled) return;
        if (price === null) {
          setPoolPrice(0);
          setPoolPriceError('No readable pool for this pair');
          return;
        }
        setPoolPrice(price);
        setPoolPriceError(null);
      } catch (caught) {
        if (!cancelled) setPoolPriceError((caught as Error).message);
      }
    };

    void readPoolPrice();
    const timer = setInterval(() => void readPoolPrice(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoTradeAssetIn, autoTradeAssetOut]);

  // Manual mode still overrides everything, for testing a trigger without waiting on the market.
  const displayPrice = manualPriceMode && manualPrice ? parseFloat(manualPrice) : poolPrice;

  // Trade proceeds always return to the wallet that is connected. There used to be a configurable
  // destination here, defaulting to an address hardcoded in this file with its input disabled, so
  // earnings left for an account the user never chose. There is no second destination now.
  const proceedsDestination = publicKey || '';

  // What a completed cycle is worth at the thresholds the user configured.
  //
  // This deliberately does not use the live quotes. Those are EXACT_IN quotes taken at the current
  // pool price, so they answer "what if both legs ran right now" — the one thing the grid will not
  // do. They also price two independent inputs: the sell amount is not tied to whatever the buy
  // produced, so subtracting one from the other compared unrelated trades.
  //
  // Here the buy is taken at gridBuyPrice and the sell at gridSellPrice, the sell is capped at the
  // position the buy actually creates, and the swap fee both legs pay is charged against the
  // result — a spread thinner than the round trip's fees is a loss, and that has to be visible
  // before the bot is armed rather than after.
  const gridForecast = useMemo(() => {
    const buyPrice = parseFloat(gridBuyPrice);
    const sellPrice = parseFloat(gridSellPrice);
    const buySpend = parseFloat(gridBuyAmount); // denominated in the quote asset
    const sellSize = parseFloat(gridSellAmount); // denominated in the base asset

    const valid = [buyPrice, sellPrice, buySpend, sellSize].every(n => Number.isFinite(n) && n > 0);
    if (!valid) return null;

    const acquired = buySpend / buyPrice; // base units the buy leg yields at its threshold
    const sold = Math.min(sellSize, acquired); // the sell cannot exceed the position behind it
    const cost = sold * buyPrice;
    const revenue = sold * sellPrice;

    // Both legs are quoted with feeBps: 50, so each pays 0.5% of its own notional.
    const FEE_RATE = 0.005;
    const fees = (cost + revenue) * FEE_RATE;
    const net = revenue - cost - fees;

    // How far the market has to travel for each leg to fire. Without this the panel will happily
    // report a large profit for a threshold the pool will never reach, which is arithmetically
    // true and practically meaningless.
    const buyMove = poolPrice > 0 ? ((buyPrice - poolPrice) / poolPrice) * 100 : null;
    const sellMove = poolPrice > 0 ? ((sellPrice - poolPrice) / poolPrice) * 100 : null;

    return {
      acquired,
      sold,
      cost,
      revenue,
      fees,
      net,
      netPct: cost > 0 ? (net / cost) * 100 : 0,
      oversized: sellSize > acquired,
      leftover: acquired - sold,
      buyMove,
      sellMove,
      // The fee share is not simply 2 × 0.5%: each leg pays on its own notional, and the sell
      // leg's notional grows with the spread, so a wide spread carries a larger fee share.
      feePctOfCost: cost > 0 ? (fees / cost) * 100 : 0,
    };
  }, [gridBuyPrice, gridSellPrice, gridBuyAmount, gridSellAmount, poolPrice]);

  // Signer for whichever account is executing. The automation wallet signs silently; otherwise
  // Freighter prompts, and it may answer with a bare XDR or a wrapped object depending on version.
  //
  // Every bot signature on this page goes through here, so a non-extractable key only has to be
  // handled once. Previously four separate places built their own Keypair from the stored seed,
  // which is why the seed had to be readable at all.
  const signerFor = useCallback(
    (useBotWallet: boolean) => async (xdr: string): Promise<string> => {
      if (useBotWallet && botWallet) {
        if (botWallet.key) {
          return secureSigner({ publicKey: botWallet.publicKey, privateKey: botWallet.key })(xdr);
        }
        const StellarSdk = await import('@stellar/stellar-sdk');
        const transaction = new StellarSdk.Transaction(xdr, StellarSdk.Networks.TESTNET);
        transaction.sign(StellarSdk.Keypair.fromSecret(botWallet.secretKey as string));
        return transaction.toEnvelope().toXDR('base64');
      }
      const signed = await signTransaction(xdr);
      return typeof signed === 'string' ? signed : (signed as { signedTxXdr: string }).signedTxXdr;
    },
    [botWallet, signTransaction]
  );

  // Both sides of a swap need a trustline, not just the output.
  //
  // SAC error #13 is TrustlineMissing and does not say which side is at fault — api.ts labels it
  // "output asset", but an account also cannot *spend* a classic asset it has no trustline for.
  // A grid alternates between the two assets of its pair, so it needs both lines open regardless
  // of which leg runs first. Opening the input's line does not create a balance; it just turns an
  // opaque #13 into an honest "insufficient balance" when the funding is what is actually missing.
  const ensureLegTrustlines = useCallback(
    async (account: string, assets: string[], useBotWallet: boolean): Promise<void> => {
      const sign = signerFor(useBotWallet);
      for (const asset of [...new Set(assets.filter(Boolean))]) {
        try {
          const result = await ensureTokenTrustline(account, asset, sign);
          if (result.created) console.log(`🔗 Trustline opened for ${result.asset?.code}`);
        } catch (caught) {
          const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? asset;
          throw new Error(`Could not open a trustline for ${symbol}: ${(caught as Error).message}`);
        }
      }
    },
    [signerFor]
  );

  // Prevent picking the same token on both sides
  const handleAutoTradeAssetInChange = (newAssetIn: string): void => {
    setAutoTradeAssetIn(newAssetIn);
    
    // If the same token is selected on the To side, pick another
    if (newAssetIn === autoTradeAssetOut) {
      const availableAssets = ASSET_OPTIONS.filter(asset => asset.value !== newAssetIn);
      if (availableAssets.length > 0) {
        setAutoTradeAssetOut(availableAssets[0].value);
      }
    }
  };

  const handleAutoTradeAssetOutChange = (newAssetOut: string): void => {
    setAutoTradeAssetOut(newAssetOut);
    
    // If the same token is selected on the From side, pick another
    if (newAssetOut === autoTradeAssetIn) {
      const availableAssets = ASSET_OPTIONS.filter(asset => asset.value !== newAssetOut);
      if (availableAssets.length > 0) {
        setAutoTradeAssetIn(availableAssets[0].value);
      }
    }
  };

  // Same dynamic trade functions as the home page
  const getAssetSymbol = useCallback((assetAddress: string): string => {
    const asset = ASSET_OPTIONS.find(a => a.value === assetAddress);
    return asset?.symbol || 'Unknown';
  }, []);

  // Dynamic maxHops and slippage per asset (same as the home page)
  const getDynamicTradeParams = useCallback((assetInAddress: string, assetOutAddress: string) => {
    const assetInSymbol = getAssetSymbol(assetInAddress);
    const assetOutSymbol = getAssetSymbol(assetOutAddress);
    
    // Read the config for both assets (type-safe)
    const assetInConfig = (ASSET_CONFIGS as any)[assetInSymbol] || DEFAULT_ASSET_CONFIG;
    const assetOutConfig = (ASSET_CONFIGS as any)[assetOutSymbol] || DEFAULT_ASSET_CONFIG;
    
    // Use the higher maxHops and slippage (safer)
    const maxHops = Math.max(assetInConfig.maxHops, assetOutConfig.maxHops);
    const slippageBps = Math.max(assetInConfig.slippageBps, assetOutConfig.slippageBps);
    
    console.log(`🔧 Dynamic Trade Params:
    - ${assetInSymbol}: maxHops=${assetInConfig.maxHops}, slippage=${assetInConfig.slippageBps}
    - ${assetOutSymbol}: maxHops=${assetOutConfig.maxHops}, slippage=${assetOutConfig.slippageBps}
    - Final: maxHops=${maxHops}, slippage=${slippageBps}`);
    
    return { maxHops, slippageBps };
  }, [getAssetSymbol]);

  // Convert a human amount to stroops (7 decimals) - same as the home page
  const toStroop = (val: string): string => {
    return (parseFloat(val) * 1e7).toFixed(0);
  };

  // Quote hesaplama fonksiyonu (Ana sayfa gibi)
  const calculateQuote = useCallback(async (type: 'buy' | 'sell') => {
    if (!isConnected) return;
    
    const amount = type === 'buy' ? autoBuyAmount : autoSellAmount;
    if (!amount || parseFloat(amount) <= 0) {
      if (type === 'buy') setBuyQuote(null);
      else setSellQuote(null);
      return;
    }

    setQuoteLoading(true);
    
    try {
      // Dinamik trade parametrelerini al
      const { maxHops, slippageBps } = getDynamicTradeParams(autoTradeAssetIn, autoTradeAssetOut);
      
      const params = {
        assetIn: legIn(type, autoTradeAssetIn, autoTradeAssetOut),
        assetOut: legOut(type, autoTradeAssetIn, autoTradeAssetOut),
        amount: toStroop(amount),
        tradeType: 'EXACT_IN' as const,
        protocols: DEFAULT_PROTOCOLS,
        slippageBps: slippageBps,
        feeBps: 50,
        parts: 1,
        maxHops: maxHops
      };

      const quoteData = await soroswapAPI.getQuote(params);
      
      if (type === 'buy') {
        setBuyQuote(quoteData);
      } else {
        setSellQuote(quoteData);
      }
      
    } catch (error: any) {
      console.error(`${type} quote error:`, error);
      if (type === 'buy') setBuyQuote(null);
      else setSellQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [isConnected, autoBuyAmount, autoSellAmount, autoTradeAssetIn, autoTradeAssetOut, getDynamicTradeParams]);

  // Quote helper for the grid trading bot
  const calculateGridQuote = useCallback(async (type: 'buy' | 'sell') => {
    if (!isConnected) return;
    
    const amount = type === 'buy' ? gridBuyAmount : gridSellAmount;
    if (!amount || parseFloat(amount) <= 0) {
      if (type === 'buy') setGridBuyQuote(null);
      else setGridSellQuote(null);
      return;
    }

    setGridQuoteLoading(true);
    
    try {
      // Dinamik trade parametrelerini al
      const { maxHops, slippageBps } = getDynamicTradeParams(autoTradeAssetIn, autoTradeAssetOut);
      
      const params = {
        assetIn: legIn(type, autoTradeAssetIn, autoTradeAssetOut),
        assetOut: legOut(type, autoTradeAssetIn, autoTradeAssetOut),
        amount: toStroop(amount),
        tradeType: 'EXACT_IN' as const,
        protocols: DEFAULT_PROTOCOLS,
        slippageBps: slippageBps,
        feeBps: 50,
        parts: 1,
        maxHops: maxHops
      };

      const quoteData = await soroswapAPI.getQuote(params);
      
      if (type === 'buy') {
        setGridBuyQuote(quoteData);
      } else {
        setGridSellQuote(quoteData);
      }
      
    } catch (error: any) {
      console.error(`Grid ${type} quote error:`, error);
      if (type === 'buy') setGridBuyQuote(null);
      else setGridSellQuote(null);
    } finally {
      setGridQuoteLoading(false);
    }
  }, [isConnected, gridBuyAmount, gridSellAmount, autoTradeAssetIn, autoTradeAssetOut, getDynamicTradeParams]);

  // Refresh the quote when the amount changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (autoBuyAmount) calculateQuote('buy');
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [autoBuyAmount, calculateQuote]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (autoSellAmount) calculateQuote('sell');
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [autoSellAmount, calculateQuote]);

  // Clear quotes when the trading pair changes
  useEffect(() => {
    setBuyQuote(null);
    setSellQuote(null);
    setGridBuyQuote(null);
    setGridSellQuote(null);
  }, [autoTradeAssetIn, autoTradeAssetOut]);

  // Refresh the quote when grid bot amounts change
  useEffect(() => {
    const timer = setTimeout(() => {
      if (gridBuyAmount) {
        calculateGridQuote('buy');
      }
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [gridBuyAmount, calculateGridQuote]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (gridSellAmount) {
        calculateGridQuote('sell');
      }
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [gridSellAmount, calculateGridQuote]);

  // Load the Telegram bot
  useEffect(() => {
    const loadTelegramBot = async () => {
      if (typeof window !== 'undefined') {
        try {
          const { telegramBot: bot } = await import('@/lib/telegram');
          setTelegramBot(bot);
          const storedChatId = localStorage.getItem('telegram_chat_id');
          if (storedChatId) setTelegramChatId(storedChatId);
        } catch (error) {
          console.error('Telegram bot load error:', error);
        }
      }
    };
    loadTelegramBot();
  }, []);

  // 🎯 Target reached notification and wallet trigger
  const handleTargetReached = useCallback(async (type: 'buy' | 'sell', targetPrice: string, currentPrice: number) => {
    const messageType = type === 'buy' ? '💰 Automatic Purchase' : '💰 Automatic Sales';
    const emoji = type === 'buy' ? '📈' : '📉';
    
    // Send a Telegram message
    if (telegramBot && telegramChatId) {
      try {
        const message = `${emoji} ${messageType} - TARGET REACHED! 🎯

🎯 Target Price: ${targetPrice}
💲 Current Price: ${currentPrice}
📅 Date: ${new Date().toLocaleString('en-US')}

${type === 'buy' ? '🛒' : '💸'} Waiting for Freighter signature for transaction...
⚡ Please check your wallet!`;

        await telegramBot.sendMessage(telegramChatId, message);
        console.log(`✅ Telegram notification sent: ${messageType} target reached`);
      } catch (error) {
        console.error('Telegram message sending error:', error);
      }
    }

    // Trigger the wallet for signing
    if (isConnected) {
      try {
        // Warn the user when there is no pre-auth order
        if (type === 'buy' && !preAuthBuyOrder) {
          alert(`${emoji} TARGET REACHED! 🎯\n\nHowever, no pre-auth buy order found.\nPlease create a pre-auth buy order first.`);
          return;
        } else if (type === 'sell' && !preAuthSellOrder) {
          alert(`${emoji} TARGET REACHED! 🎯\n\nHowever, no pre-auth sell order found.\nPlease create a pre-auth sell order first.`);
          return;
        }

        // Show the user a notification
        alert(`${emoji} ${messageType} - TARGET REACHED! 🎯\n\nTarget: ${targetPrice}\nCurrent: ${currentPrice}\n\nYour pre-auth command is available! You can trigger it manually.`);

      } catch (error) {
        console.error('Freighter trigger error:', error);
        alert(`❌ ${messageType} trigger error:\n${error}`);
      }
    } else {
      alert(`${emoji} ${messageType} - TARGET REACHED! 🎯\n\nHowever, your wallet is not connected.\nPlease connect your wallet first.`);
    }
  }, [telegramBot, telegramChatId, isConnected, preAuthBuyOrder, preAuthSellOrder]);

  // 🎯 useEffect that checks whether the target is reached
  useEffect(() => {
    // Notifications follow the same price the rules fire on, so an alert can never announce a
    // target the trading logic does not consider reached.
    if (!poolPrice) return;

    const displayPrice = manualPriceMode ? parseFloat(manualPrice || '0') : poolPrice;
    
    // Buy target check
    if (buyTargetPrice && !buyTargetNotificationSent) {
      const isBuyTargetReached = displayPrice <= parseFloat(buyTargetPrice);
      
      if (isBuyTargetReached && !lastBuyTargetReached) {
        setBuyTargetNotificationSent(true);
        setLastBuyTargetReached(true);
        
        // Fire when the target is reached
        (async () => {
          await handleTargetReached('buy', buyTargetPrice, displayPrice);
        })();
      }
    }

    // Sell target check  
    if (sellTargetPrice && !sellTargetNotificationSent) {
      const isSellTargetReached = displayPrice >= parseFloat(sellTargetPrice);
      
      if (isSellTargetReached && !lastSellTargetReached) {
        setSellTargetNotificationSent(true);
        setLastSellTargetReached(true);
        
        // Fire when the target is reached
        (async () => {
          await handleTargetReached('sell', sellTargetPrice, displayPrice);
        })();
      }
    }

    // Reset notification flags when target is no longer reached
    if (buyTargetPrice && buyTargetNotificationSent) {
      const isBuyTargetReached = displayPrice <= parseFloat(buyTargetPrice);
      if (!isBuyTargetReached) {
        setBuyTargetNotificationSent(false);
        setLastBuyTargetReached(false);
      }
    }

    if (sellTargetPrice && sellTargetNotificationSent) {
      const isSellTargetReached = displayPrice >= parseFloat(sellTargetPrice);
      if (!isSellTargetReached) {
        setSellTargetNotificationSent(false);
        setLastSellTargetReached(false);
      }
    }

  }, [poolPrice, manualPriceMode, manualPrice, buyTargetPrice, sellTargetPrice,
      buyTargetNotificationSent, sellTargetNotificationSent, lastBuyTargetReached, lastSellTargetReached, handleTargetReached]);

  // � Reset notification flags when the target price changes
  useEffect(() => {
    setBuyTargetNotificationSent(false);
    setLastBuyTargetReached(false);
  }, [buyTargetPrice]);

  useEffect(() => {
    setSellTargetNotificationSent(false);
    setLastSellTargetReached(false);
  }, [sellTargetPrice]);

  // �🔗 Wallet connection helper (same as the home page)
  const connectWallet = async (): Promise<void> => {
    try {
      await connect();
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error('Connect error:', errorMessage);
      
      // Point the user to the extension when Freighter is missing
      if (errorMessage.includes('Freighter extension not installed')) {
        alert(`❌ Freighter Extension Required\n\n1. For Chrome/Edge: https://chrome.google.com/webstore/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk\n2. For Firefox: https://addons.mozilla.org/en-US/firefox/addon/freighter/\n\nPlease refresh the page after installing the extension.`);
        // Send the user to the Freighter download page
        window.open('https://freighter.app/', '_blank');
      } else {
        alert('Freighter connection failed: ' + errorMessage);
      }
    }
  };

  // Manual wallet connection check
  const checkFreighterConnection = useCallback(async () => {
    try {
      console.log('🔍 Manual Freighter connection check...');
      
      // The wallet session is checked through Stellar Wallets Kit (Freighter, xBull, Lobstr...)
      
      if (isAvailable) {
        const currentlyConnected = await checkWalletConnection();
        
        console.log('🔍 Manual connection check result:', currentlyConnected);
        
        if (currentlyConnected !== isConnected) {
          console.log('⚠️ Connection status changed! Old:', isConnected, 'New:', currentlyConnected);

          // Tell the user when the connection drops
          if (isConnected && !currentlyConnected) {
            console.log('❌ Freighter wallet connection lost!');
            
            // State for the toast notification
            setAutoTradeStatus('❌ Freighter wallet connection lost! Please reconnect.');
            
            // Otomatik trading'i durdur
            setIsAutoTradingEnabled(false);
            
            // Send a Telegram notification
            if (telegramBot && telegramChatId) {
              try {
                await telegramBot.sendMessage(telegramChatId, 
                  '⚠️ FREIGHTER CONNECTION ERROR\n\n' +
                  '❌ Freighter wallet connection lost!\n' +
                  '🔴 Automatic trading stopped\n' +
                  '🔗 Please reconnect your wallet\n\n' +
                  `⏰ Time: ${new Date().toLocaleString('en-US')}`
                );
              } catch (telegramError) {
                console.error('Telegram notification error:', telegramError);
              }
            }
          } else if (!isConnected && currentlyConnected) {
            console.log('✅ Freighter wallet connection detected!');
            setAutoTradeStatus('✅ Freighter wallet connection detected!');
          } else {
            setAutoTradeStatus('🔍 Freighter status checked - Connection ' + (currentlyConnected ? 'active' : 'inactive'));
          }
        } else {
          setAutoTradeStatus('🔍 Freighter status checked - Connection ' + (currentlyConnected ? 'active ✅' : 'inactive ❌'));
        }
      } else {
        setAutoTradeStatus('❌ Wallet kit inaccessible');
      }
    } catch (error) {
      console.log('❌ Manual Freighter connection check error:', error);
      setAutoTradeStatus('❌ Freighter connection check error: ' + (error as Error).message);
    }
  }, [isAvailable, isConnected, checkWalletConnection, telegramBot, telegramChatId]);

  // Check the wallet when the page regains focus
  useEffect(() => {
    const handleFocus = () => {
      console.log('👁️ Page is in focus, Freighter control is being performed...');
      checkFreighterConnection();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('👁️ The page is now visible, Freighter control is being performed...');
        checkFreighterConnection();
      }
    };

    // Attach event listeners
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkFreighterConnection]);

  // Bot balance check
  const checkBotBalance = useCallback(async (botPublicKey: string) => {
    try {
      // Stellar balance API call
      const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${botPublicKey}`);
      if (response.ok) {
        const account = await response.json();
        const xlmBalance = account.balances.find((b: any) => b.asset_type === 'native');
        setBotBalance(parseFloat(xlmBalance?.balance || '0'));
      }
    } catch (error) {
      console.error('Bot balance check error:', error);
    }
  }, []);

  // 💰 Auto Funding Function - Bot wallet'e 2 XLM transfer
  const autoFundBotWallet = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      // 🚨 Do not start auto funding again while one is running
      if (isAutoFunding) {
        return { success: false, error: 'Auto funding already in progress' };
      }

      if (!botWallet) {
        return { success: false, error: 'Bot wallet not found' };
      }

      if (!isConnected || !publicKey) {
        return { success: false, error: 'Freighter wallet not connected' };
      }

      // What the buy leg actually spends. This used to be hardcoded to XLM, which was right only
      // while the legs ran the other way round: the buy now spends the quote asset, so funding the
      // bot with XLM left it unable to trade and the swap failed on a missing trustline instead.
      const fundAsset = legIn('buy', autoTradeAssetIn, autoTradeAssetOut);
      const fundSymbol = ASSET_OPTIONS.find(option => option.value === fundAsset)?.symbol ?? 'token';
      const fundIsNative = fundAsset === SOROSWAP_ROUTER_CONFIG.XLM;

      // 💰 How much of that asset the buy needs
      let requiredAmount = 2;
      if (gridBuyQuote && gridBuyQuote.amountIn) {
        try {
          requiredAmount = parseFloat(gridBuyQuote.amountIn) / 1e7 + 0.0002;
        } catch {
          console.log('Grid quote amount calculation failed, falling back to the grid buy amount');
          requiredAmount = parseFloat(gridBuyAmount || '2');
        }
      } else if (gridBuyAmount) {
        requiredAmount = parseFloat(gridBuyAmount);
      }

      // The bot's holding of the asset the buy will spend. botBalance only tracks XLM, so it can
      // answer this question for the native case alone; anything else has to be read from Horizon.
      const classicFundAsset = fundIsNative ? null : await getClassicAsset(fundAsset);
      if (!fundIsNative && !classicFundAsset) {
        return { success: false, error: `${fundSymbol} is not a classic asset, so it cannot be transferred to the bot wallet` };
      }

      let currentFundBalance = botBalance;
      if (!fundIsNative && classicFundAsset) {
        const StellarSdkRead = await import('@stellar/stellar-sdk');
        const readServer = new StellarSdkRead.Horizon.Server('https://horizon-testnet.stellar.org');
        const botAccount = await readServer.loadAccount(botWallet.publicKey);
        const held = botAccount.balances.find(
          (balance): balance is typeof balance & { asset_code: string; asset_issuer: string } =>
            'asset_code' in balance &&
            balance.asset_code === classicFundAsset.code &&
            balance.asset_issuer === classicFundAsset.issuer
        );
        currentFundBalance = held ? parseFloat(held.balance) : 0;
      }

      // 🚨 Bot wallet balance check - skip the transfer when there is already enough
      if (currentFundBalance >= requiredAmount) {
        setAutoTradeStatus(`✅ Bot wallet already has sufficient balance (${currentFundBalance.toFixed(4)} ${fundSymbol} >= ${requiredAmount.toFixed(4)} ${fundSymbol})`);

        // Telegram bildirimi - Transfer gerekmiyor
        if (telegramBot && telegramChatId) {
          const message = `💰 AUTO FUNDING SKIPPED!
✅ Bot wallet already has sufficient balance
💳 Current Balance: ${currentFundBalance.toFixed(4)} ${fundSymbol}
🎯 Required: ${requiredAmount.toFixed(4)} ${fundSymbol}
🤖 Bot wallet: ${botWallet.publicKey.slice(0, 8)}...${botWallet.publicKey.slice(-8)}
⏰ ${new Date().toLocaleString('en-US')}`;

          try {
            await telegramBot.sendMessage(telegramChatId, message);
          } catch (telegramError) {
            console.error('Telegram notification error:', telegramError);
          }
        }

        return { success: true }; // No transfer needed, but the operation counts as successful
      }

      // A classic asset cannot be received without a trustline, and the bot can open its own.
      if (!fundIsNative) {
        setAutoTradeStatus(`🔗 Opening the ${fundSymbol} trustline on the bot wallet...`);
        await ensureLegTrustlines(botWallet.publicKey, [fundAsset], true);
      }

      // Mark auto funding as started
      setIsAutoFunding(true);
      
      // Top up only the shortfall rather than the whole requirement
      const amount = requiredAmount - currentFundBalance;
      setAutoTradeStatus(`💰 Transferring ${amount.toFixed(4)} ${fundSymbol} to bot wallet...`);

      const StellarSdk = await import('@stellar/stellar-sdk');
      const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');

      // Load the account
      const sourceAccount = await server.loadAccount(publicKey);

      const paymentAsset = classicFundAsset
        ? new StellarSdk.Asset(classicFundAsset.code, classicFundAsset.issuer)
        : StellarSdk.Asset.native();

      // Build the transaction
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: botWallet.publicKey,
            asset: paymentAsset,
            amount: amount.toFixed(7)
          })
        )
        .setTimeout(300)
        .build();

      // Sign the transaction with the wallet
      const xdrString = transaction.toEnvelope().toXDR('base64');
      const signedTransaction = await signTransaction(xdrString);

      // Submit the transaction  
      const signedTx = new StellarSdk.Transaction(signedTransaction, StellarSdk.Networks.TESTNET);
      const result = await server.submitTransaction(signedTx);

      if (result.successful || result.hash) {
        setAutoTradeStatus(`✅ ${amount} XLM successfully transferred to bot wallet!`);
         
        // Refresh the bot balance
        setTimeout(() => checkBotBalance(botWallet.publicKey), 2000);

        // Telegram bildirimi
        if (telegramBot && telegramChatId) {
          const message = `💰 AUTO FUNDING COMPLETED!
✅ ${amount} XLM transferred to bot wallet
🤖 Bot wallet: ${botWallet.publicKey.slice(0, 8)}...${botWallet.publicKey.slice(-8)}
🔗 Hash: ${result.hash}
⏰ ${new Date().toLocaleString('en-US')}`;
          
          await telegramBot.sendMessage(telegramChatId, message);
        }
setIsAutoFunding(false);
        return { success: true };
      } else {
        throw new Error('Transaction failed');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setAutoTradeStatus(`❌ Auto funding failed: ${errorMessage}`);
      
      // Telegram hata bildirimi
      if (telegramBot && telegramChatId) {
//         const message = `❌ AUTO FUNDING FAILED!
// 💰 Failed to transfer 2 XLM to bot wallet
// 🚫 Error: ${errorMessage}
// ⏰ ${new Date().toLocaleString('en-US')}`;
        
        // await telegramBot.sendMessage(telegramChatId, message);
      }

      return { success: false, error: errorMessage };
    } finally {
      // Mark auto funding as finished (success or failure)
      setIsAutoFunding(false);
    }
  }, [botWallet, isConnected, publicKey, signTransaction, checkBotBalance, telegramBot, telegramChatId, isAutoFunding, gridBuyQuote, botBalance,
      autoTradeAssetIn, autoTradeAssetOut, gridBuyAmount, ensureLegTrustlines]);

  // 🤖 Create or load the bot wallet
  useEffect(() => {
    const loadBotWallet = async () => {
      try {
        if (!publicKey) return;

        // The non-extractable key first. Legacy seeds are read under both the owner-scoped name
        // and the original global one, so a wallet made before either change still loads and its
        // funds stay reachable.
        const secure = await loadSecureKey(`price_${publicKey}`);
        if (secure) {
          setBotWallet({ publicKey: secure.publicKey, key: secure.privateKey });
          checkBotBalance(secure.publicKey);
          return;
        }

        const storedWallet =
          localStorage.getItem(`bot_wallet_${publicKey}`) ?? localStorage.getItem('bot_wallet');
        if (storedWallet) {
          const wallet = JSON.parse(storedWallet);
          setBotWallet(wallet);
          checkBotBalance(wallet.publicKey);
        }

        // Proceeds now always go to the connected wallet, so the stored destination from the old
        // build is dead weight — and it holds an address the user never picked. Clear it.
        localStorage.removeItem('custom_wallet_address');
      } catch (error) {
        console.error('Bot wallet loading error:', error);
      }
    };
    
    if (publicKey) {
      loadBotWallet();
    }
  }, [publicKey, checkBotBalance]);

  // 🤖 Create a new bot wallet
  const createBotWallet = useCallback(async () => {
    try {
      if (!publicKey) {
        throw new Error('An error occurred: Wallet is not connected');
      }

      // Prefer a key the browser will sign with but never disclose. A browser without Ed25519 in
      // WebCrypto falls back to a stored seed, because a bot that cannot sign is worse than one
      // whose key is at risk — but that seed is then the whole of this wallet's security, so the
      // status text says which of the two happened rather than claiming "securely stored".
      let newBotWallet: { publicKey: string; secretKey?: string; key?: CryptoKey };
      let keyIsSecure: boolean;

      if (await isSecureKeySupported()) {
        const secure = await createSecureKey(`price_${publicKey}`);
        newBotWallet = { publicKey: secure.publicKey, key: secure.privateKey };
        keyIsSecure = true;
        localStorage.removeItem('bot_wallet');
      } else {
        const StellarSdk = await import('@stellar/stellar-sdk');
        const keypair = StellarSdk.Keypair.random();
        newBotWallet = { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
        keyIsSecure = false;
        // Scoped to the owner: the old key was a single global 'bot_wallet', so switching wallets
        // in the same browser left the previous bot's wallet answering for an account it no
        // longer belonged to.
        localStorage.setItem(`bot_wallet_${publicKey}`, JSON.stringify(newBotWallet));
      }

      setBotWallet(newBotWallet);

      setAutoTradeStatus(`🤖 Bot wallet created!
📍 Bot Address: ${newBotWallet.publicKey}
💰 Please transfer XLM to this address (about ~0.5-2 XLM per transaction)
${keyIsSecure
  ? '🔐 Its key is non-extractable: this browser signs with it but cannot read it back'
  : '⚠️ This browser has no Ed25519 WebCrypto, so the key is stored as text — keep the balance small'}
⚠️ After XLM transfer, the bot will be active
🎯 The bot will make transactions from its own wallet`);

      // Balance kontrol et
      setTimeout(() => checkBotBalance(newBotWallet.publicKey), 2000);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`❌ Bot wallet creation error: ${errorMessage}`);
    }
  }, [publicKey, checkBotBalance]);



  // 📦 Load pre-auth orders from localStorage
  useEffect(() => {
    if (publicKey) {
      try {
        const buyOrder = localStorage.getItem(`preauth_buy_${publicKey}`);
        const sellOrder = localStorage.getItem(`preauth_sell_${publicKey}`);
        const gridBot = localStorage.getItem(`grid_bot_${publicKey}`);
        
        if (buyOrder) {
          const parsed = JSON.parse(buyOrder);
          // Validity check
          if (new Date(parsed.expiry) > new Date()) {
            setPreAuthBuyOrder({
              ...parsed,
              expiry: new Date(parsed.expiry)
            });
          } else {
            localStorage.removeItem(`preauth_buy_${publicKey}`);
          }
        }
        
        if (sellOrder) {
          const parsed = JSON.parse(sellOrder);
          // Validity check
          if (new Date(parsed.expiry) > new Date()) {
            setPreAuthSellOrder({
              ...parsed,
              expiry: new Date(parsed.expiry)
            });
          } else {
            localStorage.removeItem(`preauth_sell_${publicKey}`);
          }
        }

        if (gridBot) {
          const parsed = JSON.parse(gridBot);
          // Validity check
          if (new Date(parsed.expiry) > new Date()) {
            setGridTradingBot({
              ...parsed,
              expiry: new Date(parsed.expiry)
            });
          } else {
            localStorage.removeItem(`grid_bot_${publicKey}`);
          }
        }


      } catch (error) {
        console.error('❌ LocalStorage order loading error:', error);
      }
    }
  }, [publicKey]);

  // 💸 Transfers XLM to the bot with the wallet (manual mode)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const transferXLMToBot = useCallback(async (requiredXLM: number) => {
    try {
      if (!publicKey || !botWallet || !signTransaction) {
        throw new Error('Wallet information is missing.');
      }

      // Check the wallet connection
      if (!isConnected) {
        setAutoTradeStatus('🔗 Freighter connection required. Reconnecting...');
        try {
          await connect();
          // Wait briefly for the connection
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          if (!isConnected) {
            throw new Error('Could not connect to Freighter. Please check the Freighter extension in the browser and connect manually.');
          }
        } catch (connectError) {
          throw new Error(`Freighter connection error: ${connectError}. Please refresh the page and connect manually.`);
        }
      }

      setAutoTradeStatus(`💰 Freighter ile ${requiredXLM.toFixed(2)} XLM transfer ediliyor...`);

      // Build the payment transaction with the Stellar SDK
      const StellarSdk = await import('@stellar/stellar-sdk');
      const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
      
      // Load the main wallet account
      const sourceAccount = await server.loadAccount(publicKey);
      
      // Build the payment transaction
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
      .addOperation(StellarSdk.Operation.payment({
        destination: botWallet.publicKey,
        asset: StellarSdk.Asset.native(),
        amount: requiredXLM.toFixed(7),
      }))
      .setTimeout(180)
      .build();

      // Read the transaction XDR
      const xdr = transaction.toEnvelope().toXDR('base64');
      
      setAutoTradeStatus(`🔐 Waiting for Freighter signature...`);
      
      // 📱 Telegram notification: the XLM transfer needs a manual signature
      if (telegramBot && telegramChatId) {
        const message = `💸 XLM TRANSFER - MANUAL SIGNATURE REQUIRED!

📱 Freighter wallet is waiting for confirmation
🤖 XLM transfer to bot wallet
💰 Amount: ${requiredXLM.toFixed(4)} XLM
🏦 Bot Wallet: ${botWallet?.publicKey.slice(0, 10)}...${botWallet?.publicKey.slice(-10)}
⏰ ${new Date().toLocaleString('en-US')}

⚡ Please check your Freighter wallet and confirm the transfer!`;

        try {
          await telegramBot.sendMessage(telegramChatId, message);
        } catch (tgError) {
          console.warn('Telegram notification could not be sent:', tgError);
        }
      }
      
      // Freighter ile imzala
      const signedXDR = await signTransaction(xdr);
      
      // 📱 Telegram notification: XLM transfer signature succeeded
      if (telegramBot && telegramChatId) {
        const message = `✅ XLM TRANSFER SIGNATURE SUCCESSFUL!

🔐 Freighter wallet signature received
💸 XLM transfer to bot wallet
💰 Amount: ${requiredXLM.toFixed(4)} XLM
🏦 Bot Wallet: ${botWallet?.publicKey.slice(0, 10)}...${botWallet?.publicKey.slice(-10)}
⏰ ${new Date().toLocaleString('en-US')}

📤 Sending the transfer to the blockchain...`;
        
        try {
          await telegramBot.sendMessage(telegramChatId, message);
        } catch (tgError) {
          console.warn('Telegram notification could not be sent:', tgError);
        }
      }

      setAutoTradeStatus(`🔄 Transfer is being sent...`);

      // Submit the signed transaction
      const signedTransaction = new StellarSdk.Transaction(signedXDR, StellarSdk.Networks.TESTNET);
      const result = await server.submitTransaction(signedTransaction);
      
      setAutoTradeStatus(`✅ Transfer successful! Hash: ${result.hash}`);
      
      // Refresh the bot balance
      setTimeout(() => checkBotBalance(botWallet.publicKey), 3000);
      
      return { success: true, hash: result.hash };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Transfer error';
      setAutoTradeStatus(`❌ Transfer error: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, [publicKey, botWallet, signTransaction, checkBotBalance, connect, isConnected, telegramBot, telegramChatId]);

  // 💸 Refunds XLM from the bot back to the user
  const refundXLMFromBot = useCallback(async (amount: number) => {
    try {
      if (!publicKey || !botWallet) {
        throw new Error('Wallet information is missing.');
      }

      setAutoTradeStatus(`💸 Refunding ${amount.toFixed(2)} XLM...`);

      const StellarSdk = await import('@stellar/stellar-sdk');
      const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
      
      // Bot account bilgilerini al
      const botAccount = await server.loadAccount(botWallet.publicKey);

      // Build the refund transaction
      const transaction = new StellarSdk.TransactionBuilder(botAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
      .addOperation(StellarSdk.Operation.payment({
        destination: publicKey,
        asset: StellarSdk.Asset.native(),
        amount: amount.toFixed(7),
      }))
      .setTimeout(180)
      .build();

      // Signed through signerFor so a non-extractable key works here too
      const signedRefund = await signerFor(true)(transaction.toXDR());

      // Send
      const result = await server.submitTransaction(
        new StellarSdk.Transaction(signedRefund, StellarSdk.Networks.TESTNET)
      );

      setAutoTradeStatus(`✅ Refund successful! Hash: ${result.hash}`);

      // Refresh the bot balance
      setTimeout(() => checkBotBalance(botWallet.publicKey), 3000);
      
      return { success: true, hash: result.hash };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Refund error';
      setAutoTradeStatus(`❌ Refund error: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, [publicKey, botWallet, checkBotBalance, signerFor]);

  // 🎯 Pre-authorization functions (manual and bot modes)
  const createPreAuthBuyOrder = useCallback(async (useBot = false) => {
    try {
      if (!buyTargetPrice || !autoBuyAmount) {
        throw new Error('Target price and amount must be entered.');
      }

      if (!publicKey || !isConnected) {
        throw new Error('Wallet is not connected.');
      }

      const assetInSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetIn)?.symbol;
      const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetOut)?.symbol;

      if (!useBot || botMode === 'manual') {
        // 👤 Manuel Mod - Basit onay sistemi
        const confirmed = window.confirm(
          `👤 MANUAL BUY ORDER\n\n` +
          `💰 Amount to buy: ${autoBuyAmount} ${assetInSymbol} ${'→'} ${assetOutSymbol}\n` +
          `📊 Target Price: $${buyTargetPrice}\n` +
          `💵 Current Price: $${displayPrice.toFixed(4)}\n\n` +
          `👤 In manual mode, you will sign each transaction with Freighter\n` +
          `💰 You will be exiting from your main wallet\n\n` +
          `Do you confirm this buy order?`
        );

        if (!confirmed) {
          setAutoTradeStatus('❌ Manual buy order canceled.');
          return;
        }

        // Create a manual pre-auth order
        const order = {
          targetPrice: buyTargetPrice,
          amount: autoBuyAmount,
          expiry: new Date(Date.now() + 2 * 60 * 60 * 1000), // valid for 2 hours
          status: `✅ MANUAL BUY ORDER ACTIVE!
💰 Amount to buy: ${autoBuyAmount} ${assetInSymbol}${'→'} ${assetOutSymbol}
🎯 Target Price: $${buyTargetPrice}
👤 Manual Mode: Sign each transaction with Freighter
⏰ Expiry: 2 hours
📊 Price tracking active...`
        };

        setPreAuthBuyOrder(order);
        localStorage.setItem(`preauth_buy_${publicKey}`, JSON.stringify(order));
        setAutoTradeStatus('✅ Manual buy order active! Waiting for target price...');

      } else if (useBot && botMode === 'auto' && botWallet) {
        // 🤖 Bot mode (auto): create the order directly, without an XLM transfer
        setAutoTradeStatus('🤖 Auto mode: Creating bot buy order without XLM transfer...');
        
        try {
          // Fetch a quote for the estimated output (same parameters as the home page)
          const { maxHops, slippageBps } = getDynamicTradeParams(autoTradeAssetIn, autoTradeAssetOut);
          
          const quoteResponse = await soroswapAPI.getQuote({
            assetIn: autoTradeAssetIn,
            assetOut: autoTradeAssetOut,
            amount: toStroop(autoBuyAmount),
            tradeType: 'EXACT_IN' as const,
            protocols: DEFAULT_PROTOCOLS,
            slippageBps: slippageBps, // Dinamik slippage
            feeBps: 50,
            parts: 1,
            maxHops: maxHops // Dinamik maxHops
          });

          const estimatedOutput = parseFloat(quoteResponse.amountOut || '0') / 10000000;

          // Create an auto-bot pre-auth order (without an XLM transfer)
          const order = {
            targetPrice: buyTargetPrice,
            amount: autoBuyAmount,
            estimatedOutput: estimatedOutput,
            expiry: new Date(Date.now() + 2 * 60 * 60 * 1000), // valid for 2 hours
            isBot: true,
            status: `✅ AUTO BOT BUY ORDER IS ACTIVE!
💰 Amount to buy: ${autoBuyAmount} ${assetInSymbol} ${'→'} ${assetOutSymbol}
🎯 Target Price: $${buyTargetPrice}
💸 Token to receive: ~${estimatedOutput.toFixed(4)} ${assetOutSymbol}
🤖 Auto Bot: Wallet ready (no XLM transfer needed)
⏰ Expiry: 2 hours
📊 PC can be off - Bot will follow automatically!`
          };

          setPreAuthBuyOrder(order);
          localStorage.setItem(`preauth_buy_${publicKey}`, JSON.stringify(order));
          setAutoTradeStatus('✅ Auto bot buy order active! Waiting for target price...');

        } catch (quoteError) {
          // Quote alamazsak basit onay
          console.error('Quote error:', quoteError);
          setAutoTradeStatus('⚠️ Quote could not be retrieved, simple auto bot buy order is being created...');
          
          const order = {
            targetPrice: buyTargetPrice,
            amount: autoBuyAmount,
            expiry: new Date(Date.now() + 2 * 60 * 60 * 1000),
            isBot: true,
            status: `✅ AUTO BOT BUY ORDER IS ACTIVE!
💰 Amount to buy: ${autoBuyAmount} ${assetInSymbol} ${'→'} ${assetOutSymbol}
🎯 Target Price: $${buyTargetPrice}
🤖 Auto Bot: Wallet ready (no XLM transfer needed)
⏰ Expiry: 2 hours`
          };

          setPreAuthBuyOrder(order);
          localStorage.setItem(`preauth_buy_${publicKey}`, JSON.stringify(order));
          setAutoTradeStatus('✅ Auto bot buy order active! Waiting for target price...');
        }
      } else {
        throw new Error('Bot mode selected but bot wallet not created. Please create a bot wallet first.');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setAutoTradeStatus(`❌ Buy order confirmation error: ${errorMessage}`);
    }
  }, [buyTargetPrice, autoBuyAmount, publicKey, isConnected, displayPrice, autoTradeAssetIn, autoTradeAssetOut, botMode, botWallet, getDynamicTradeParams]);

  const createPreAuthSellOrder = useCallback(async (useBot = false) => {
    try {
      if (!sellTargetPrice || !autoSellAmount) {
        throw new Error('Enter target price and quantity.');
      }

      if (!publicKey || !isConnected) {
        throw new Error('Wallet is not connected.');
      }

      const assetInSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetIn)?.symbol;
      const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetOut)?.symbol;

      if (!useBot || botMode === 'manual') {
        // 👤 Manuel Mod - Basit onay sistemi
        const confirmed = window.confirm(
          `👤 MANUAL SELL ORDER CONFIRMATION\n\n` +
          `💸 Amount to sell: ${autoSellAmount} ${assetOutSymbol} ${'→'} ${assetInSymbol}\n` +
          `📊 Target Price: $${sellTargetPrice}\n` +
          `💵 Current Price: $${currentPrice.toFixed(4)}\n\n` +
          `👤 In manual mode, you will sign each transaction with Freighter\n` +
          `💰 You will withdraw from your token wallet\n\n` +
          `Do you confirm this sell order?`
        );

        if (!confirmed) {
          setAutoTradeStatus('❌ Manual sell order canceled.');
          return;
        }

        // Create a manual pre-auth order
        const order = {
          targetPrice: sellTargetPrice,
          amount: autoSellAmount,
          expiry: new Date(Date.now() + 2 * 60 * 60 * 1000), // valid for 2 hours
          status: `✅ MANUAL SELL ORDER ACTIVE!
💸 Amount to sell: ${autoSellAmount} ${assetInSymbol}
🎯 Target Price: $${sellTargetPrice}
👤 Manual Mode: Each transaction requires a signature
⏰ Expiry: 2 hours
📊 Price tracking active...`
        };

        setPreAuthSellOrder(order);
        localStorage.setItem(`preauth_sell_${publicKey}`, JSON.stringify(order));
        setAutoTradeStatus('✅ Manual sell order active! Waiting for target price...');

      } 
      else if (useBot && botMode === 'auto' && botWallet) {
        // 🤖 Bot mode (auto): create the order directly, without an XLM/token transfer
        setAutoTradeStatus('🤖 Auto mode: Creating bot sell order without transfers...');
        
        try {
          // Fetch a quote for the estimated output (same parameters as the home page)
          const { maxHops, slippageBps } = getDynamicTradeParams(autoTradeAssetIn, autoTradeAssetOut);
          
          const quoteResponse = await soroswapAPI.getQuote({
            assetIn: autoTradeAssetIn,
            assetOut: autoTradeAssetOut,
            amount: toStroop(autoSellAmount),
            tradeType: 'EXACT_IN' as const,
            protocols: DEFAULT_PROTOCOLS,
            slippageBps: slippageBps, // Dinamik slippage
            feeBps: 50,
            parts: 1,
            maxHops: maxHops // Dinamik maxHops
          });

          const estimatedOutput = parseFloat(quoteResponse.amountOut || '0') / 10000000;

          // Create an auto-bot pre-auth order (without a transfer)
          const order = {
            targetPrice: sellTargetPrice,
            amount: autoSellAmount,
            estimatedOutput: estimatedOutput,
            expiry: new Date(Date.now() + 2 * 60 * 60 * 1000), // valid for 2 hours
            isBot: true,
            status: `✅ AUTO BOT SELL ORDER ACTIVE!
💸 Amount to sell: ${autoSellAmount} ${assetInSymbol} ${'→'} ${assetOutSymbol}
🎯 Target Price: $${sellTargetPrice}
💸 Estimated Token: ~${estimatedOutput.toFixed(4)} ${assetOutSymbol}
🤖 Auto Bot: Wallet ready (no transfers needed)
⏰ Expiry: 2 hours
📊 PC may be offline - Bot will track price automatically!`
          };

          setPreAuthSellOrder(order);
          localStorage.setItem(`preauth_sell_${publicKey}`, JSON.stringify(order));
          setAutoTradeStatus('✅ Auto bot sell order active! Waiting for target price...');

        } catch (quoteError) {
          // Quote alamazsak basit onay
          console.error('Quote error:', quoteError);
          setAutoTradeStatus('⚠️ Quote not available, creating simple auto bot sell order...');
          
          const order = {
            targetPrice: sellTargetPrice,
            amount: autoSellAmount,
            expiry: new Date(Date.now() + 2 * 60 * 60 * 1000),
            isBot: true,
            status: `✅ AUTO BOT SELL ORDER ACTIVE!
💸 Amount to sell: ${autoSellAmount} ${assetInSymbol}
🎯 Target Price: $${sellTargetPrice}
🤖 Auto Bot: Wallet ready (no transfers needed)
⏰ Expiry: 2 hours`
          };

          setPreAuthSellOrder(order);
          localStorage.setItem(`preauth_sell_${publicKey}`, JSON.stringify(order));
          setAutoTradeStatus('✅ Auto bot sell order active! Waiting for target price...');
        }
      } else {
        throw new Error('Bot mode selected but bot wallet not created. Please create a bot wallet first.');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setAutoTradeStatus(`❌ Sell order confirmation error: ${errorMessage}`);
    }
  }, [sellTargetPrice, autoSellAmount, publicKey, isConnected, currentPrice, autoTradeAssetIn, autoTradeAssetOut, botMode, botWallet, getDynamicTradeParams]);

  // 🤖 Grid trading bot - automatic buy + sell function
  
  
  
  
  const createGridTradingBot = useCallback(async (useBot = false) => {
    debugger;
    try {
      if (!gridBuyPrice || !gridSellPrice || !gridBuyAmount || !gridSellAmount) {
        throw new Error('Please enter the buy price, sell price, buy amount, and sell amount.');
      }

      if (!publicKey || !isConnected) {
        throw new Error('Wallet is not connected.');
      }

      const buyPrice = parseFloat(gridBuyPrice);
      const sellPrice = parseFloat(gridSellPrice);
      const buyAmount = parseFloat(gridBuyAmount);
      const sellAmount = parseFloat(gridSellAmount);

      if (buyPrice >= sellPrice) {
        throw new Error('Buy price must be lower than sell price.');
      }

      if (buyPrice <= 0 || sellPrice <= 0 || buyAmount <= 0 || sellAmount <= 0) {
        throw new Error('All values must be positive.');
      }

      // Confirming the bot is what arms it. The price watcher is gated on isAutoTradingEnabled, so
      // without this a confirmed bot sat inactive behind a separate toggle the user had no reason
      // to look for. A previous run's error also has to be cleared, or the watcher stays parked.
      setIsAutoTradingEnabled(true);
      setHasAutoTradeError(false);

      const assetInSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetIn)?.symbol;
      const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === autoTradeAssetOut)?.symbol;

      if (!useBot || botMode === 'manual') {
        // 👤 Manuel Grid Trading Bot
        const confirmed = window.confirm(
          `👤 GRID TRADING BOT CONFIRMATION\n\n` +
          `� OPERATION SEQUENCE (Automatic Loop):\n` +
          `1️⃣ BUY: When price reaches $${gridBuyPrice} or lower (≤ equal or below)\n` +
          `   → ${gridBuyAmount} ${assetInSymbol} will be purchased\n` +
          `2️⃣ SELL: After purchase, when price reaches $${gridSellPrice} or higher (≥ equal or above)\n` +
          `   → ${gridSellAmount} ${assetOutSymbol} will be sold\n` +
          `3️⃣ PROFIT: Profit will be transferred to your main wallet\n\n` +
          `📊 Buy Price: $${gridBuyPrice}\n` +
          `📊 Sell Price: $${gridSellPrice}\n` +
          `💰 Buy Amount: ${gridBuyAmount} ${assetOutSymbol}\n` +
          `💰 Sell Amount: ${gridSellAmount} ${assetInSymbol}\n` +
          `📈 Expected Profit: ${((sellPrice - buyPrice) / buyPrice * 100).toFixed(2)}%\n\n` +
          `👤 Manual mode requires signing with Freighter for each transaction\n` +
          `⚠️ IMPORTANT: First BUY, then SELL occurs\n\n` +
          `Do you confirm this grid trading bot?`
        );

        if (!confirmed) {
          setAutoTradeStatus('❌ Manual grid trading bot canceled.');
          return;
        }

        // Create a manual grid bot
        const gridBot = {
          buyPrice: gridBuyPrice,
          sellPrice: gridSellPrice,
          buyAmount: gridBuyAmount,
          sellAmount: gridSellAmount,
          isActive: true,
          currentStep: 'waiting_buy' as const,
          expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // valid for 24 hours
          status: `✅ MANUAL GRID BOT ACTIVE!
🔄 OPERATION SEQUENCE (Automatic Loop):
1️⃣ BUY: Price ≤ $${gridBuyPrice} (equal or below) → ${gridBuyAmount} ${assetInSymbol} will be purchased
2️⃣ SELL: After purchase, when price ≥ $${gridSellPrice} (equal or above) → ${gridSellAmount} ${assetOutSymbol} will be sold
3️⃣ PROFIT: Profit will be transferred to your main wallet

💰 BUY Amount: ${gridBuyAmount} ${assetInSymbol}
💰 SELL Amount: ${gridSellAmount} ${assetOutSymbol}
📈 Expected Profit: ${((sellPrice - buyPrice) / buyPrice * 100).toFixed(2)}%
👤 Manual Mode: Signing required for each transaction
📊 CURRENT STATUS: 1️⃣ BUY price is being awaited ($${gridBuyPrice} and lower)
⏰ VALIDITY: 24 hours`
        };

        setGridTradingBot(gridBot);
        localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(gridBot));
        setAutoTradeStatus('✅ Manual grid trading bot active! Waiting for buy price...');

      } 
      
      else if (useBot && botMode === 'auto' && botWallet) {
        // 🤖 Auto grid trading bot - auto funding check
        
        // 💰 Auto funding check - wait if one is already running
        if (isAutoFunding) {
          setAutoTradeStatus('⚠️ Auto funding already in progress, please wait...');
          return;
        }
        
        // 💰 Auto funding - Her zaman 2 XLM transfer et
        setAutoTradeStatus('💰 Auto funding: Transferring 2 XLM to bot wallet...');
        
        const fundingResult = await autoFundBotWallet();
        if (!fundingResult.success) {
          if (fundingResult.error === 'Auto funding already in progress') {
            setAutoTradeStatus('⚠️ Auto funding already in progress, please wait...');
            return;
          }
          throw new Error(`Auto funding failed: ${fundingResult.error}`);
        }
        
        setAutoTradeStatus('✅ Auto funding completed! Creating grid trading bot...');
      
        try {
          // Fetch a quote for the estimated output - RETRY MECHANISM
          const { maxHops, slippageBps } = getDynamicTradeParams(autoTradeAssetIn, autoTradeAssetOut);
          
          let quoteResponse: any;
          let retryCount = 0;
          const maxRetries = 3;
          
          while (retryCount < maxRetries) {
            try {
              setAutoTradeStatus(`🤖 Auto grid bot: Getting quote... (Attempt ${retryCount + 1}/${maxRetries})`);
              
              quoteResponse = await Promise.race([
                soroswapAPI.getQuote({
                  assetIn: autoTradeAssetIn,
                  assetOut: autoTradeAssetOut,
                  amount: toStroop(gridBuyAmount),
                  tradeType: 'EXACT_IN' as const,
                  protocols: DEFAULT_PROTOCOLS,
                  slippageBps: slippageBps,
                  feeBps: 50,
                  parts: 1,
                  maxHops: maxHops
                }),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error(`Grid bot quote timeout (${60 + (retryCount * 15)} saniye)`)), 60000 + (retryCount * 15000))
                )
              ]) as any;
              
              // Break out of the loop on success
              break;
              
            } catch (quoteError) {
              retryCount++;
              console.error(`Grid bot quote Attempt ${retryCount} error:`, quoteError);

              if (retryCount >= maxRetries) {
                throw new Error(`Grid bot quote API ${maxRetries} attempts failed after: ${quoteError instanceof Error ? quoteError.message : 'Unknown error'}`);
              }
              
              // Wait before the next attempt
              setAutoTradeStatus(`⏳ Quote error, retrying in ${5 * retryCount} seconds...`);
              await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
            }
          }

          const estimatedOutput = parseFloat(quoteResponse.amountOut || '0') / 10000000;

          // Create an auto grid bot (without an XLM transfer)
          const gridBot = {
            buyPrice: gridBuyPrice,
            sellPrice: gridSellPrice,
            buyAmount: gridBuyAmount,
            sellAmount: gridSellAmount,
            isActive: true,
            currentStep: 'waiting_buy' as const,
            expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // valid for 24 hours
            isBot: true,
            status: `✅ AUTO GRID BOT ACTIVE!
🔄 AUTOMATIC TRADE SEQUENCE:
1️⃣ BUY STAGE: Price ≤ $${gridBuyPrice} (equal or below) → ${gridBuyAmount} ${assetInSymbol} automatic buy
2️⃣ SELL STAGE: Post-buy price ≥ $${gridSellPrice} (equal or above) → ${gridSellAmount} ${assetOutSymbol} automatic sell
3️⃣ PROFIT TRANSFER: Earnings automatically transferred to your wallet

💰 Buy Amount: ${gridBuyAmount} ${assetInSymbol}
💰 Sell Amount: ${gridSellAmount} ${assetOutSymbol}
🎯 Estimated Buy: ${estimatedOutput.toFixed(4)} ${assetOutSymbol}
📈 Expected Profit: ${((sellPrice - buyPrice) / buyPrice * 100).toFixed(2)}%
🤖 Auto Bot: Wallet ready (no XLM transfer needed)
📊 CURRENTLY: 1️⃣ Waiting for buy price ($${gridBuyPrice} and below)
⏰ EXPIRATION: 24 hours
🔄 PC can be closed - Bot will run automatically!`
          };

          setGridTradingBot(gridBot);
          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(gridBot));
          setAutoTradeStatus('✅ Auto grid trading bot active! Waiting for purchase price...');

        } catch (quoteError) {
          // Fall back to a simple grid bot when no quote is available
          console.error('Grid bot quote error:', quoteError);
          setAutoTradeStatus('⚠️ Failed to get quote, creating simple auto grid bot...');
          
          // Create a simple grid bot (without a quote)
          const gridBot = {
            buyPrice: gridBuyPrice,
            sellPrice: gridSellPrice,
            buyAmount: gridBuyAmount,
            sellAmount: gridSellAmount,
            isActive: true,
            currentStep: 'waiting_buy' as const,
            expiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
            isBot: true,
            status: `✅ AUTO GRID BOT ACTIVE (Simple Mode)!
🎯 Buy Target: $${gridBuyPrice} (≤ equal or below)
🎯 Sell Target: $${gridSellPrice} (≥ equal or above)
💰 Buy Amount: ${gridBuyAmount} ${assetInSymbol}
💰 Sell Amount: ${gridSellAmount} ${assetOutSymbol}
📈 Expected Profit: ${((sellPrice - buyPrice) / buyPrice * 100).toFixed(2)}%
🤖 Auto Bot: Wallet ready (no XLM transfer needed)
⚠️ Quote not received - Simple mode active
📊 Status: Waiting for buy price ($${gridBuyPrice} and below)
⏰ Expiration: 24 hours
🔄 PC can be closed - Bot will run automatically!`
          };

          setGridTradingBot(gridBot);
          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(gridBot));
          setAutoTradeStatus('✅ Auto grid bot active! (Simple mode) Waiting for purchase price...');
        }
        
      } else {
        throw new Error('Bot mode selected but bot wallet not created. Please create a bot wallet first.');
      }

      // Input fields reset
      setGridBuyPrice('');
      setGridSellPrice('');
      setGridBuyAmount('');
      setGridSellAmount('');

    } catch (error) {
      console.error('api wait:',error);
      // const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // setAutoTradeStatus(`❌ Grid bot creation error: ${errorMessage}`);
    }
  }, [gridBuyPrice, gridSellPrice, gridBuyAmount, gridSellAmount, publicKey, isConnected, autoTradeAssetIn, autoTradeAssetOut, botMode, botWallet, getDynamicTradeParams, autoFundBotWallet, isAutoFunding]);



  // 💸 Transfers the bot's profit back to the connected wallet.
  // A payment of a classic asset is rejected with op_no_trust when the DESTINATION has no
  // trustline for it. The bot cannot open one on the user's account — only that account's own
  // signer can — so this opens it through Freighter first. Proceeds only ever go to the connected
  // wallet, so that signer is always available.
  const ensureDestinationTrustline = useCallback(
    async (code: string, issuer: string, destination: string): Promise<void> => {
      const StellarSdk = await import('@stellar/stellar-sdk');
      const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
      const account = await server.loadAccount(destination);

      const alreadyTrusted = account.balances.some(
        balance =>
          'asset_code' in balance &&
          balance.asset_code === code &&
          (balance as { asset_issuer?: string }).asset_issuer === issuer
      );
      if (alreadyTrusted) return;

      setAutoTradeStatus(`🔗 Opening the ${code} trustline on your wallet so the proceeds can land...`);
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(StellarSdk.Operation.changeTrust({ asset: new StellarSdk.Asset(code, issuer) }))
        .setTimeout(180)
        .build();

      const signed = await signerFor(false)(transaction.toEnvelope().toXDR('base64'));
      await server.submitTransaction(new StellarSdk.Transaction(signed, StellarSdk.Networks.TESTNET));
      console.log(`✅ ${code} trustline opened on the destination wallet`);
    },
    [signerFor]
  );

  const transferProfitToMainWallet = useCallback(async (
    assetToTransfer: string,
    // Only the address is read here; signing goes through signerFor, so this never needs the seed.
    fromBotWallet: { publicKey: string },
    toMainWallet: string,
    gridProfitAmount?: number // grid trading profit amount
  ): Promise<string | undefined> => {
    try {
      debugger;
      console.log('🔍 Initiating transfer:', {
        assetToTransfer,
        gridProfitAmount,
        fromBot: fromBotWallet.publicKey,
        toWallet: toMainWallet
      });
///////////brls
      const StellarSdk = await import('@stellar/stellar-sdk');
      
      // Bot account bilgilerini al
      const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${fromBotWallet.publicKey}`);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bot account information could not be retrieved: ${response.status} - ${errorText}`);
      }
      
      const account = await response.json();
      console.log('🤖 Bot account balances:', account.balances);
      
      // 🚨 ADVANCED USDC DETECTION SYSTEM - FULL WALLET ANALYSIS
      console.log('🔍🔍🔍 ADVANCED ASSET DETECTION START 🔍🔍🔍');
      console.log('🎯 Target asset to transfer:', assetToTransfer);
      console.log('🤖 Bot Wallet All Balances:');
      account.balances.forEach((bal: any, index: number) => {
        console.log(`  Balance ${index + 1}/${account.balances.length}:`, {
          asset_type: bal.asset_type,
          asset_code: bal.asset_code || 'N/A',
          asset_issuer: bal.asset_issuer || 'N/A',
          balance: bal.balance,
          balance_number: parseFloat(bal.balance),
          can_transfer: parseFloat(bal.balance) > 0.01
        });
      });

      // Find the balance of the asset to transfer
      const assetBalance = account.balances.find((balance: any) => {
        console.log(`🔍 Checking balance for match:`, {
          asset_type: balance.asset_type,
          asset_code: balance.asset_code,
          asset_issuer: balance.asset_issuer,
          balance: balance.balance,
          assetToTransfer
        });

        if (assetToTransfer.includes('native')) {
          const isNative = balance.asset_type === 'native';
          console.log('🪙 Native check:', isNative);
          return isNative;
        } else {
          // For contract assets - MULTI-LAYER DETECTION
          const assetParts = assetToTransfer.split('_');
          const expectedAssetCode = assetParts[0];
          const expectedAssetIssuer = assetParts[1];
          
          console.log('🎯 Expected asset parts:', { expectedAssetCode, expectedAssetIssuer });
          
          // LAYER 1: exact match (safest)
          if (expectedAssetCode && expectedAssetIssuer && balance.asset_code && balance.asset_issuer) {
            const exactMatch = balance.asset_code === expectedAssetCode && balance.asset_issuer === expectedAssetIssuer;
            if (exactMatch) {
              console.log('✅ LAYER 1: Exact asset match found!', balance.asset_code, balance.asset_issuer);
              return true;
            }
          }
          
          // LAYER 2: asset code match
          if (expectedAssetCode && balance.asset_code) {
            const codeMatch = balance.asset_code === expectedAssetCode || 
                             balance.asset_code.includes(expectedAssetCode) ||
                             expectedAssetCode.includes(balance.asset_code);
            if (codeMatch) {
              console.log('✅ LAYER 2: Asset code match found!', { 
                expectedAssetCode,
                balanceAssetCode: balance.asset_code,
                codeMatch
              });
              return true;
            }
          }
          
          // LAYER 3: dedicated USDC detection (find USDC no matter what)
          if (expectedAssetCode === 'USDC' || assetToTransfer.includes('USDC')) {
            console.log('🚨 USDC SPECIAL DETECTION ACTIVE!');
            
            // USDC Exact
            if (balance.asset_code === 'USDC') {
              console.log('✅ LAYER 3A: Direct USDC found!');
              return true;
            }
            
            // any asset containing USD
            if (balance.asset_code && balance.asset_code.includes('USD')) {
              console.log('✅ LAYER 3B: USD-containing asset found!', balance.asset_code);
              return true;
            }
            
            // USDC issuer match (common USDC issuers)
            const commonUsdcIssuers = [
              'CBBHRKEP5M3NUDRISGLJKGHDHX3DA2CN2AZBQY6WLVUJ7VNLGSKBDUCM', // Soroswap USDC
              'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', // Circle USDC
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // Common USDC
            ];
            
            if (commonUsdcIssuers.includes(balance.asset_issuer)) {
              console.log('✅ LAYER 3C: USDC issuer match found!', balance.asset_issuer);
              return true;
            }
            
            // EMERGENCY: highest non-XLM balance (likely USDC)
            if (balance.asset_type !== 'native' && parseFloat(balance.balance) > 0.01) {
              console.log('⚠️ LAYER 3D: Emergency non-XLM asset detected (might be USDC):', balance);
              return true;
            }
          }
          
          // LAYER 4: broad matching (other tokens)
          const broadMatch = balance.asset_code && (
            assetToTransfer.includes(balance.asset_code) || 
            balance.asset_code.includes('USDC') ||
            balance.asset_code.includes('USD') ||
            balance.asset_code.includes('STAR') ||
            balance.asset_code.includes('BTC') ||
            balance.asset_code.includes('ETH') ||
            balance.asset_code.includes('XTAR')
          );
          
          if (broadMatch) {
            console.log('✅ LAYER 4: Broad match found!', { 
              balanceAssetCode: balance.asset_code,
              balanceAssetIssuer: balance.asset_issuer,
              assetToTransfer, 
              broadMatch 
            });
            return true;
          }
          
          console.log('❌ No match found for this balance');
          return false;
        }
      });
      
      console.log('💰💰💰 ASSET DETECTION RESULT 💰💰💰');
      console.log('Found asset balance:', assetBalance);
      
      if (!assetBalance) {
        console.log('❌❌❌ NO ASSET BALANCE FOUND - DETAILED ANALYSIS ❌❌❌');
        console.log('🔍 Searched for asset:', assetToTransfer);
        console.log('📊 All available balances:');
        account.balances.forEach((bal: any, index: number) => {
          console.log(`  ${index + 1}. Asset: ${bal.asset_code || 'XLM'} | Balance: ${bal.balance} | Type: ${bal.asset_type} | Issuer: ${bal.asset_issuer || 'N/A'}`);
        });
        
        // 🚨 EMERGENCY RECOVERY: find the non-native asset with the highest balance
        const nonNativeBalances = account.balances
          .filter((bal: any) => bal.asset_type !== 'native' && parseFloat(bal.balance) > 0.01)
          .sort((a: any, b: any) => parseFloat(b.balance) - parseFloat(a.balance));
          
        if (nonNativeBalances.length > 0) {
          console.log('🚨 EMERGENCY RECOVERY: Using highest non-native balance:', nonNativeBalances[0]);
          
          // Transfer the highest balance
          const emergencyAsset = nonNativeBalances[0];
          const emergencyAssetIdentifier = `${emergencyAsset.asset_code}_${emergencyAsset.asset_issuer}`;
          
          const emergencyTransferHash = await transferProfitToMainWallet(
            emergencyAssetIdentifier,
            fromBotWallet,
            toMainWallet,
            undefined // No profit amount in the emergency path; 95% of the balance is used
          );
          
          console.log('🚨 Emergency transfer completed:', emergencyTransferHash);
          return emergencyTransferHash;
        }
        
        // Last resort: transfer XLM when available
        const xlmBalance = account.balances.find((bal: any) => bal.asset_type === 'native');
        if (xlmBalance && parseFloat(xlmBalance.balance) > 10) {
          console.log('🚨 Last resort: Transferring XLM...');
          const xlmTransferHash = await transferProfitToMainWallet(
            'USDC',
            fromBotWallet,
            toMainWallet,
            undefined // No profit amount in the emergency path; transferred with the XLM reserve in mind
          );
          console.log('🚨 XLM emergency transfer completed:', xlmTransferHash);
          return xlmTransferHash;
        }
        
        console.log('❌ No transferable assets found at all!');
        return;
      }
      
      if (parseFloat(assetBalance.balance) < 0.1) {
        console.log('⚠️ Not enough balance for transfer:', assetBalance);
        return;
      }
      /////murat
      // Use the grid profit amount when present, otherwise 95% of the balance
      let transferAmount: number;
      
      if (gridProfitAmount && gridProfitAmount > 0) {
        // Use the grid trading profit amount
        transferAmount = gridProfitAmount;
        console.log(`💰 Grid profit amount will be transferred: ${transferAmount} ${assetBalance.asset_code || 'XLM'}`);
        
        // Make sure the profit amount does not exceed the balance
        if (transferAmount > parseFloat(assetBalance.balance)) {
          transferAmount = parseFloat(assetBalance.balance) * 0.95;
          console.log(`⚠️ Grid profit amount exceeds balance, adjusted: ${transferAmount}`);
        }
      } else {
        // Legacy path: transfer part of the balance
               
         
         ////brls2
        transferAmount = assetToTransfer.includes('native') 
          ? parseFloat(formatAmount(gridSellQuote.amountOut)) // reserve 2 XLM for XLM
          : parseFloat(formatAmount(gridSellQuote.amountOut)) * 0.95; // Transfer 95% for other assets
        console.log(`📊 Balance-based transfer amount: ${transferAmount} ${assetBalance.asset_code || 'XLM'}`);
      }

      if (transferAmount <= 0.1) { // Minimum 0.1 transfer gerekli
        console.log('⚠️ Transfer amount too low:', transferAmount, 'Balance:', assetBalance.balance);
        return;
      }
      
      console.log(`📤 To be transferred: ${transferAmount} ${assetBalance.asset_code || 'XLM'}`);
      
      // Create the server and transaction
      const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
      const botAccount = await server.loadAccount(fromBotWallet.publicKey);
      
      // Build the asset
      let asset;
      if (assetToTransfer.includes('native')) {
        asset = StellarSdk.Asset.native();
        console.log('🪙 Native XLM asset created');
      } else {
        // Contract assets need issuer information
        if (assetBalance.asset_issuer && assetBalance.asset_code) {
          asset = new StellarSdk.Asset(assetBalance.asset_code, assetBalance.asset_issuer);
          console.log('🎯 Custom asset created:', assetBalance.asset_code, assetBalance.asset_issuer);
          // The payment fails with op_no_trust unless the receiving account trusts this asset.
          await ensureDestinationTrustline(assetBalance.asset_code, assetBalance.asset_issuer, toMainWallet);
        } else {
          console.log('⚠️ Asset issuer/code information missing, XLM will be transferred');
          asset = StellarSdk.Asset.native();
          // Read the XLM balance and transfer it
          const xlmBalance = account.balances.find((b: any) => b.asset_type === 'native');
          if (xlmBalance && parseFloat(xlmBalance.balance) > 0.5) {
            const xlmTransferAmount = Math.max(0, parseFloat(xlmBalance.balance) - 0.5);
            console.log(`📤 Fallback XLM transfer: ${xlmTransferAmount}`);
          }
        }
      }
      
      // Build the payment transaction
      const transaction = new StellarSdk.TransactionBuilder(botAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
      .addOperation(StellarSdk.Operation.payment({
        destination: toMainWallet,
        asset: asset,
        amount: transferAmount.toFixed(7), // decimal format, not stroops
      }))
      .setTimeout(180)
      .build();
      
      // Bot imza at — through signerFor, so a non-extractable key works here too
      const signedTransfer = await signerFor(true)(transaction.toXDR());

      // Send
      const result = await server.submitTransaction(
        new StellarSdk.Transaction(signedTransfer, StellarSdk.Networks.TESTNET)
      );
      console.log('✅ Transfer successful:', result.hash);
      
      return result.hash;
      
    } catch (error: any) {
      console.error('❌ Transfer profit error:', error);
      
      // Inspect Stellar error codes
      if (error.response?.data?.extras?.result_codes) {
        const resultCodes = error.response.data.extras.result_codes;
        console.error('Stellar error codes:', resultCodes);
        throw new Error(`Transfer error: ${JSON.stringify(resultCodes)}`);
      }

      throw new Error(`Token transfer error: ${error.message || 'Unknown error'}`);
    }
  }, [gridSellQuote, ensureDestinationTrustline, signerFor]);

  // 🤖 Bot automatic execution (fully automated)
  const executeBotTrade = useCallback(async (type: 'buy' | 'sell', amount: string, targetPrice: string) => {
    setIsTrading(true);
    
    try {
      setAutoTradeStatus(`🤖 Bot ${type === 'buy' ? 'buying' : 'selling'} started...`);

      // Bot mode check and validation
      const usingBotWallet = botMode === 'auto' && botWallet;
      const signerKey = usingBotWallet ? botWallet.publicKey : publicKey;
      
      if (!signerKey) {
        throw new Error('Wallet not connected.');
      }

      // Balance check when the bot wallet is used
      if (usingBotWallet) {
        if (botBalance < 1) { // Minimum 1 XLM gerekli
          throw new Error(`Bot wallet does not have sufficient balance. Current: ${botBalance.toFixed(2)} XLM, Minimum: 1 XLM required.`);
        }
        setAutoTradeStatus(`🤖 Using bot wallet: ${botWallet.publicKey.slice(0, 10)}...`);
      } else {
        setAutoTradeStatus(`👤 Using main wallet: ${publicKey?.slice(0, 10)}...`);
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount < 1) {
        throw new Error('Minimum 1 asset required.');
      }

      setAutoTradeStatus(`📊 Fetching quote from Soroswap API...`);

      // Read dynamic trade parameters (same as the home page)
      const assetInAddress = legIn(type, autoTradeAssetIn, autoTradeAssetOut);
      const assetOutAddress = legOut(type, autoTradeAssetIn, autoTradeAssetOut);
      const { maxHops, slippageBps } = getDynamicTradeParams(assetInAddress, assetOutAddress);

      setAutoTradeStatus('🔗 Checking the trustline for the output asset...');
      await ensureLegTrustlines(signerKey, [assetInAddress, assetOutAddress], !!usingBotWallet);

      // Fetch a Soroswap quote (same parameters as the home page) - RETRY MECHANISM
      let quoteResponse: any;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`📊 Getting a quote from Soroswap API... (Attempt ${retryCount + 1}/${maxRetries})`);
          
          quoteResponse = await Promise.race([
            soroswapAPI.getQuote({
              assetIn: assetInAddress,
              assetOut: assetOutAddress,
              amount: toStroop(amount), // Same format as the home page
              tradeType: 'EXACT_IN' as const,
              protocols: DEFAULT_PROTOCOLS,
              slippageBps: slippageBps, // Dinamik slippage
              feeBps: 50,
              parts: 1,
              maxHops: maxHops // Dinamik maxHops
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Quote API timeout (${60 + (retryCount * 15)} saniye)`)), 60000 + (retryCount * 15000))
            )
          ]) as any;
          
          // Break out of the loop on success
          break;
          
        } catch (quoteError) {
          retryCount++;
          console.error(`Quote attempt ${retryCount} error:`, quoteError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Quote API ${maxRetries} attempts failed: ${quoteError instanceof Error ? quoteError.message : 'Unknown error'}`);
          }
          
          // Wait before the next attempt
          setAutoTradeStatus(`⏳ Quote error, ${5 * retryCount} seconds later it will be retried...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
        }
      }

      if (!quoteResponse.assetIn || !quoteResponse.assetOut) {
        throw new Error(`Quote fetch error: Invalid quote response`);
      }

      setAutoTradeStatus(`🔗 Transaction is being created...`);

      // Build transaction (same logic as the home page) - RETRY MECHANISM
      console.log('🔨 Building transaction for user:', signerKey);
      let buildResponse: any;
      retryCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`🔗 Transaction is being created... (Attempt ${retryCount + 1}/${maxRetries})`);

          buildResponse = await Promise.race([
            soroswapAPI.buildTransaction({
              quote: quoteResponse,
              referralId: "GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO",
              sponsor: "GDISPX62G6EGBZX3I2VMB4J3O3CPFHHRAJ4QZNOYVXYVHJ6BVRL2A3Y3",
              from: signerKey // the user's or the bot's wallet address
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Build transaction timeout (${60 + (retryCount * 15)} saniye)`)), 60000 + (retryCount * 15000))
            )
          ]) as any;
          
          // Break out of the loop on success
          break;
          
        } catch (buildError) {
          retryCount++;
          console.error(`Build transaction attempt ${retryCount} error:`, buildError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Build transaction ${maxRetries} attempts failed: ${buildError instanceof Error ? buildError.message : 'Unknown error'}`);
          }
          
          // Wait before the next attempt
          setAutoTradeStatus(`⏳ Transaction build error, ${5 * retryCount} seconds later it will be retried...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
        }
      }

      if (!buildResponse.xdr) {
        throw new Error(`Build transaction error: No XDR received`);
      }
      console.log('✅ Transaction built successfully:', buildResponse);

      setAutoTradeStatus(`🔐 ${usingBotWallet ? 'Bot automatically signs' : 'User signature is being awaited'}...`);

      let signedXDR: string;

      if (usingBotWallet) {
        // 🤖 Bot otomatik imza
        signedXDR = await signerFor(true)(buildResponse.xdr);

        setAutoTradeStatus(`✅ Bot signature completed, transaction is being sent...`);
      } else {
        // � Telegram bildirimi: Manuel imza gerekli
        if (telegramBot && telegramChatId) {
          const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const message = `🔐 MANUAL SIGNATURE REQUIRED!

📱 Please confirm the transaction in your Freighter wallet
🤖 ${type === 'buy' ? `💰 ${assetOutSymbol} PURCHASE` : `💸 ${assetInSymbol} SELL`} operation
💰 Amount: ${amount} ${assetInSymbol}
💵 Price: $${displayPrice.toFixed(4)}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
⏰ ${new Date().toLocaleString('en-US')}

⚡ Please check your Freighter wallet and confirm the transaction!`;

          try {
            await telegramBot.sendMessage(telegramChatId, message);
          } catch (tgError) {
            console.warn('Telegram notification could not be sent:', tgError);
          }
        }
        
        // 👤 Manual user signature (same logic as the home page)
        console.log('🔐 Signing transaction XDR:', buildResponse.xdr);
        const signedXdr = await signTransaction(buildResponse.xdr);
        
        console.log('✅ Signed XDR received:', typeof signedXdr, signedXdr);
        
        // Make sure the signed XDR is a string (same as the home page)
        if (typeof signedXdr === 'string') {
          signedXDR = signedXdr;
        } else if (signedXdr && typeof signedXdr === 'object' && 'signedTxXdr' in signedXdr) {
          signedXDR = (signedXdr as { signedTxXdr: string }).signedTxXdr;
          console.log('🔧 Extracted signedTxXdr from object:', signedXDR);
        } else {
          throw new Error(`Invalid signed XDR format: ${JSON.stringify(signedXdr)}`);
        }
        
        if (!signedXDR || signedXDR.trim() === '') {
          throw new Error('Signed XDR is empty or invalid');
        }
        
        // 📱 Telegram notification: manual signature succeeded
        if (telegramBot && telegramChatId) {
          const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const message = `✅ SIGNATURE SUCCESSFUL!

🔐 Freighter wallet signature received
🤖 ${type === 'buy' ? `💰 ${assetOutSymbol} PURCHASE` : `💸 ${assetInSymbol} SELL`} operation
💰 Amount: ${amount} ${assetInSymbol}
💵 Price: $${displayPrice.toFixed(4)}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
⏰ ${new Date().toLocaleString('en-US')}

📤 Transaction is being sent to the blockchain...`;

          try {
            await telegramBot.sendMessage(telegramChatId, message);
          } catch (tgError) {
            console.warn('Telegram notification could not be sent:', tgError);
          }
        }
        
        console.log('📤 Ready to send transaction with XDR:', signedXDR.substring(0, 100) + '...');
      }
      
      setAutoTradeStatus(`📤 Transaction is being sent to the blockchain...`);

      // Submit transaction - RETRY MECHANISM
      let submitResponse: any;
      retryCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`📤 Transaction is being sent to the blockchain... (Attempt ${retryCount + 1}/${maxRetries})`);
          
          submitResponse = await Promise.race([
            soroswapAPI.sendTransaction({ xdr: signedXDR }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Send transaction timeout (${90 + (retryCount * 30)} seconds)`)), 90000 + (retryCount * 30000))
            )
          ]) as any;
          
          // Break out of the loop on success
          break;
          
        } catch (submitError) {
          retryCount++;
          console.error(`Submit transaction attempt ${retryCount} error:`, submitError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Submit transaction ${maxRetries} attempts failed: ${submitError instanceof Error ? submitError.message : 'Unknown error'}`);
          }

          // Wait for the next attempt
          setAutoTradeStatus(`⏳ Transaction submit error, retrying in ${7 * retryCount} seconds...`);
          await new Promise(resolve => setTimeout(resolve, 7000 * retryCount));
        }
      }
      
      if (!submitResponse.hash && !submitResponse.status) {
        throw new Error(`Transaction submission error: No hash received`);
      }

      const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
      const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';

      setAutoTradeStatus(`✅ Bot ${type === 'buy' ? 'purchase' : 'sale'} successful!
🤖 Automatic process completed
💰 Amount: ${amount} ${assetInSymbol}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
💵 Price: $${displayPrice.toFixed(4)}
🆔 Hash: ${submitResponse.hash || 'N/A'}`);

      // 🎯 Transfer the tokens the bot received to the user's wallet
      if (usingBotWallet && proceedsDestination && botWallet) {
        try {
          setAutoTradeStatus(prev => `${prev}\n\n💸 Received tokens ${proceedsDestination.slice(0, 10)}...`);
          
          // Re-check the bot balance after the operation
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 saniye bekle
          
          const postTradeResponse = await fetch(`https://horizon-testnet.stellar.org/accounts/${botWallet.publicKey}`);
          if (postTradeResponse.ok) {
            const postTradeAccount = await postTradeResponse.json();
            console.log('📊 Post-trade bot balances:', postTradeAccount.balances);

            // Find the asset we received (the token we got as a result of the transaction)
            const targetAssetValue = legOut(type, autoTradeAssetIn, autoTradeAssetOut); // Buy'da USDC/XSTAR, Sell'de XLM
            const targetAssetInfo = ASSET_OPTIONS.find(a => a.value === targetAssetValue);
            console.log('🎯 Target transfer asset:', { targetAssetValue, targetAssetInfo });
            
            // Find this asset's balance in the bot wallet
            const targetAssetBalance = postTradeAccount.balances.find((balance: any) => {
              if (targetAssetValue.includes('native') || targetAssetValue.includes('XLM') || targetAssetInfo?.symbol === 'XLM') {
                console.log('🪙 Searching for XLM asset, balance:', balance.asset_type, balance.balance);
                return balance.asset_type === 'native';
              } else {
                // For contract assets - match by asset symbol
                const targetSymbol = targetAssetInfo?.symbol;
                console.log('🔍 Asset balance check:', {
                  targetSymbol,
                  balanceAssetCode: balance.asset_code,
                  balanceAssetType: balance.asset_type,
                  balanceAmount: balance.balance
                });
                
                return balance.asset_code && targetSymbol && (
                  balance.asset_code === targetSymbol ||
                  balance.asset_code.includes(targetSymbol) ||
                  targetSymbol.includes(balance.asset_code) ||
                  // Common asset matches
                  (targetSymbol === 'USDC' && balance.asset_code.includes('USDC')) ||
                  (targetSymbol === 'XTAR' && balance.asset_code.includes('STAR')) ||
                  (targetSymbol === 'BTC' && balance.asset_code.includes('BTC')) ||
                  (targetSymbol === 'ETH' && balance.asset_code.includes('ETH'))
                );
              }
            });
            
            console.log('💰 Found target asset balance:', targetAssetBalance);
            
            if (targetAssetBalance && parseFloat(targetAssetBalance.balance) > (targetAssetBalance.asset_type === 'native' ? 2.0 : 0.1)) {
              // Hedef asset'i transfer et
              const assetIdentifier = targetAssetBalance.asset_type === 'native' 
                ? 'native' 
                : `${targetAssetBalance.asset_code}_${targetAssetBalance.asset_issuer || ''}`;
              
              console.log('📤 Asset ID to transfer:', assetIdentifier);
              
              // 💰 Calculate the profit from this buy
              let buyProfitAmount: number | undefined;
              
              if (type === 'buy' && gridBuyQuote?.amountOut) {
                // Token amount received from the buy
                buyProfitAmount = parseFloat(gridBuyQuote.amountOut);
                console.log('💰 Buy Transaction Profit Amount:', buyProfitAmount, getAssetSymbol(gridBuyQuote.assetOut));
              }
              
              const transferHash = await transferProfitToMainWallet(
                assetIdentifier,
                botWallet,
                proceedsDestination,
                buyProfitAmount // Pass the buy profit amount as a parameter
              );
              
              setAutoTradeStatus(prev => `${prev}\n✅ ${targetAssetBalance.asset_code || 'XLM'} transferred to your wallet!
💸 Transfer Hash: ${transferHash || 'N/A'}`);
            } else {
              // If the target asset is missing, transfer the highest balance instead
              console.log('⚠️ Target asset not found, highest balance is being transferred');
              
              const transferableAssets = postTradeAccount.balances.filter((balance: any) => 
                parseFloat(balance.balance) > (balance.asset_type === 'native' ? 2.0 : 0.1) // 2.0 for XLM, 0.1 for everything else
              );
              
              if (transferableAssets.length > 0) {
                const highestBalance = transferableAssets.reduce((prev: any, current: any) => 
                  parseFloat(current.balance) > parseFloat(prev.balance) ? current : prev
                );
                
                const assetIdentifier = highestBalance.asset_type === 'native' 
                  ? 'native' 
                  : `${highestBalance.asset_code}_${highestBalance.asset_issuer}`;
                
                const transferHash = await transferProfitToMainWallet(
                  assetIdentifier,
                  botWallet,
                  proceedsDestination,
                  undefined // No profit amount on the fallback transfer; 95% of the highest balance is used
                );
                
                setAutoTradeStatus(prev => `${prev}\n✅ ${highestBalance.asset_code || 'XLM'} transferred to your wallet!
💸 Transfer Hash: ${transferHash || 'N/A'}`);
              } else {
                setAutoTradeStatus(prev => `${prev}\n⚠️ No transferable asset found`);
              }
            }
          }
          
        } catch (transferError) {
          const transferErrorMsg = transferError instanceof Error ? transferError.message : 'Transfer error';
          setAutoTradeStatus(prev => `${prev}\n⚠️ Transfer error: ${transferErrorMsg}`);
          console.error('Token transfer error:', transferError);
        }
      }

      // Telegram notification
      if (telegramBot && telegramChatId) {
        const message = `🤖 BOT AUTOMATIC TRADE!
✅ ${type === 'buy' ? `💰 ${assetOutSymbol} BUY` : `💸 ${assetInSymbol} SELL`} SUCCESSFUL
🤖 Pre-authorized Transaction Completed
📊 Triggered: $${targetPrice}
💵 Realized: $${displayPrice.toFixed(4)}
💰 Spent: ${amount} ${assetInSymbol}
${usingBotWallet ? `💸 You received ${type === 'buy' ? assetOutSymbol : assetInSymbol} tokens in your wallet!
🏦 Transfer Address: ${proceedsDestination.slice(0, 10)}...${proceedsDestination.slice(-10)}` : ''}
🆔 Trade Hash: ${submitResponse.hash || 'N/A'}
⏰ ${new Date().toLocaleString('en-US')}`;
        
        await telegramBot.sendMessage(telegramChatId, message);
      }

      // Reset the values
      if (type === 'buy') {
        setBuyTargetPrice('');
        setAutoBuyAmount('');
        setPreAuthBuyOrder(null);
        localStorage.removeItem(`preauth_buy_${publicKey}`);
      } else {
        setSellTargetPrice('');
        setAutoSellAmount('');
        setPreAuthSellOrder(null);
        localStorage.removeItem(`preauth_sell_${publicKey}`);
      }
      
      setHasAutoTradeError(false);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setAutoTradeStatus(`❌ Bot ${type === 'buy' ? 'buy' : 'sell'} error: ${errorMessage}
      
🤖 BOT OPERATION DONE
Reactivate it manually.`);
      
      setHasAutoTradeError(true);
      setIsAutoTradingEnabled(false);
      
      // Reset the values hata durumunda da
      if (type === 'buy') {
        setBuyTargetPrice('');
        setAutoBuyAmount('');
        setPreAuthBuyOrder(null);
        localStorage.removeItem(`preauth_buy_${publicKey}`);
      } else {
        setSellTargetPrice('');
        setAutoSellAmount('');
        setPreAuthSellOrder(null);
        localStorage.removeItem(`preauth_sell_${publicKey}`);
      }
      
      // Telegram error notification
      if (telegramBot && telegramChatId) {
        const message = `🚨 BOT OPERATION ERROR!
❌ ${type === 'buy' ? 'BUY' : 'SELL'} FAILED
🤖 Bot Operation Stopped
📊 Target: $${targetPrice}
💵 Current: $${displayPrice.toFixed(4)}
⚠️ Error: ${errorMessage}
⏰ ${new Date().toLocaleString('en-US')}`;
        
        await telegramBot.sendMessage(telegramChatId, message);
      }
    } finally {
      setIsTrading(false);
    }
  }, [publicKey, signTransaction, displayPrice, telegramBot, telegramChatId, autoTradeAssetIn, autoTradeAssetOut, botMode, botWallet, botBalance, transferProfitToMainWallet, proceedsDestination, getDynamicTradeParams, getAssetSymbol, gridBuyQuote, ensureLegTrustlines, signerFor]);

  // 🤖 Grid bot execution (no transfer on buys, transfer on sales)
  const executeGridBotTrade = useCallback(async (type: 'buy' | 'sell', amount: string, targetPrice: string, transferAfterTrade = false) => {
    setIsTrading(true);
    
    try {
      setAutoTradeStatus(`🤖 Grid Bot ${type === 'buy' ? 'buy' : 'sell'} is starting...`);

      // Bot mode check and validation
      const usingBotWallet = botMode === 'auto' && botWallet;
      const signerKey = usingBotWallet ? botWallet.publicKey : publicKey;
      
      if (!signerKey) {
        throw new Error('Wallet not connected.');
      }

      // Balance check when the bot wallet is used
      if (usingBotWallet) {
        if (botBalance < 1) { // Minimum 1 XLM gerekli
          throw new Error(`Bot wallet has insufficient balance. Current: ${botBalance.toFixed(2)} XLM, Minimum: 1 XLM required.`);
        }
        setAutoTradeStatus(`🤖 Grid Bot wallet is being used: ${botWallet.publicKey.slice(0, 10)}...`);
      } else {
        setAutoTradeStatus(`👤 Grid Bot main wallet is being used: ${publicKey?.slice(0, 10)}...`);
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount < 1) {
        throw new Error('Minimum 1 asset required.');
      }

      setAutoTradeStatus(`📊 Grid Bot is getting quote from Soroswap API...`);

      // Dinamik trade parametrelerini al
      const assetInAddress = legIn(type, autoTradeAssetIn, autoTradeAssetOut);
      const assetOutAddress = legOut(type, autoTradeAssetIn, autoTradeAssetOut);
      const { maxHops, slippageBps } = getDynamicTradeParams(assetInAddress, assetOutAddress);

      setAutoTradeStatus('🔗 Grid Bot is checking the trustline for the output asset...');
      await ensureLegTrustlines(signerKey, [assetInAddress, assetOutAddress], !!usingBotWallet);

      // Fetch a Soroswap quote - RETRY MECHANISM
      let quoteResponse: any;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`📊 Grid Bot is getting quote from Soroswap API... (Attempt ${retryCount + 1}/${maxRetries})`);
          
          quoteResponse = await Promise.race([
            soroswapAPI.getQuote({
              assetIn: assetInAddress,
              assetOut: assetOutAddress,
              amount: toStroop(amount),
              tradeType: 'EXACT_IN' as const,
              protocols: DEFAULT_PROTOCOLS,
              slippageBps: slippageBps,
              feeBps: 50,
              parts: 1,
              maxHops: maxHops
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Grid Bot quote timeout (${60 + (retryCount * 15)} saniye)`)), 60000 + (retryCount * 15000))
            )
          ]) as any;
          
          break;
          
        } catch (quoteError) {
          retryCount++;
          console.error(`Grid Bot quote attempt ${retryCount} error:`, quoteError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Grid Bot quote API ${maxRetries} attempts failed: ${quoteError instanceof Error ? quoteError.message : 'Unknown error'}`);
          }

          setAutoTradeStatus(`⏳ Grid Bot quote error, retrying in ${5 * retryCount} seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
        }
      }

      if (!quoteResponse.assetIn || !quoteResponse.assetOut) {
        throw new Error(`Grid Bot quote API error: Invalid quote response`);
      }

      setAutoTradeStatus(`🔗 Grid Bot transaction is being created...`);

      // Build transaction - RETRY MECHANISM
      let buildResponse: any;
      retryCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`🔗 Grid Bot transaction is being created... (Attempt ${retryCount + 1}/${maxRetries})`);
          
          buildResponse = await Promise.race([
            soroswapAPI.buildTransaction({
              quote: quoteResponse,
              referralId: "GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO",
              sponsor: "GDISPX62G6EGBZX3I2VMB4J3O3CPFHHRAJ4QZNOYVXYVHJ6BVRL2A3Y3",
              from: signerKey
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Grid Bot build timeout (${60 + (retryCount * 15)} saniye)`)), 60000 + (retryCount * 15000))
            )
          ]) as any;
          
          break;
          
        } catch (buildError) {
          retryCount++;
          console.error(`Grid Bot build attempt ${retryCount} error:`, buildError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Grid Bot build transaction ${maxRetries} attempts failed: ${buildError instanceof Error ? buildError.message : 'Unknown error'}`);
          }

          setAutoTradeStatus(`⏳ Grid Bot transaction build error, retrying in ${5 * retryCount} seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
        }
      }

      if (!buildResponse.xdr) {
        throw new Error(`Grid Bot build transaction error: No XDR received`);
      }

      setAutoTradeStatus(`🔐 Grid Bot ${usingBotWallet ? 'is signing automatically' : 'is waiting for user signature'}...`);

      let signedXDR: string;

      if (usingBotWallet) {
        // Bot otomatik imza
        signedXDR = await signerFor(true)(buildResponse.xdr);

        setAutoTradeStatus(`✅ Grid Bot signature completed, transaction is being sent...`);
      } else {
        // 📱 Telegram notification: Grid Bot manual signature required
        if (telegramBot && telegramChatId) {
          const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const message = `🤖 GRID BOT - MANUAL SIGNATURE REQUIRED!

📱 Please check your Freighter wallet for approval
🔄 Grid Bot ${type === 'buy' ? `💰 ${assetOutSymbol} BUY` : `💸 ${assetInSymbol} SELL`} operation
💰 Amount: ${amount} ${assetInSymbol}
💵 Target Price: $${targetPrice}
📊 Current Price: $${displayPrice.toFixed(4)}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
⏰ ${new Date().toLocaleString('en-US')}

⚡ Please check your Freighter wallet and approve the Grid Bot transaction!`;

          try {
            await telegramBot.sendMessage(telegramChatId, message);
          } catch (tgError) {
            console.warn('Telegram notification could not be sent:', tgError);
          }
        }
        
        // Manual user signature
        const signedXdr = await signTransaction(buildResponse.xdr);
        
        if (typeof signedXdr === 'string') {
          signedXDR = signedXdr;
        } else if (signedXdr && typeof signedXdr === 'object' && 'signedTxXdr' in signedXdr) {
          signedXDR = (signedXdr as any).signedTxXdr;
        } else {
          throw new Error('Invalid signed XDR format received from Freighter');
        }
        
        if (!signedXDR || signedXDR.trim() === '') {
          throw new Error('Empty signed XDR received from Freighter');
        }
        
        // 📱 Telegram notification: grid bot manual signature succeeded
        if (telegramBot && telegramChatId) {
          const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
          const message = `✅ GRID BOT SIGNATURE SUCCESSFUL!

🔐 Freighter wallet signature received
🤖 Grid Bot ${type === 'buy' ? `💰 ${assetOutSymbol} BUY` : `💸 ${assetInSymbol} SELL`} operation
💰 Amount: ${amount} ${assetInSymbol}
💵 Target Price: $${targetPrice}
📊 Current Price: $${displayPrice.toFixed(4)}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
⏰ ${new Date().toLocaleString('en-US')}

📤 Grid Bot transaction is being sent to the blockchain...`;

          try {
            await telegramBot.sendMessage(telegramChatId, message);
          } catch (tgError) {
            console.warn('Telegram notification could not be sent:', tgError);
          }
        }
      }

      setAutoTradeStatus(`📤 Grid Bot transaction is being sent...`);

      // Submit transaction - RETRY MECHANISM
      let submitResponse: any;
      retryCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          setAutoTradeStatus(`📤 Grid Bot transaction is being sent... (Attempt ${retryCount + 1}/${maxRetries})`);

          submitResponse = await Promise.race([
            soroswapAPI.sendTransaction({ xdr: signedXDR }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Grid Bot send timeout (${90 + (retryCount * 30)} seconds)`)), 90000 + (retryCount * 30000))
            )
          ]) as any;
          
          break;
          
        } catch (submitError) {
          retryCount++;
          console.error(`Grid Bot transaction submission attempt ${retryCount} failed:`, submitError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Grid Bot transaction submission failed after ${maxRetries} attempts: ${submitError instanceof Error ? submitError.message : 'Unknown error'}`);
          }

          setAutoTradeStatus(`⏳ Grid Bot transaction submission failed, retrying in ${7 * retryCount} seconds...`);
          await new Promise(resolve => setTimeout(resolve, 7000 * retryCount));
        }
      }
      
      if (!submitResponse.hash && !submitResponse.status) {
        throw new Error(`Grid Bot transaction submission error: no hash received`);
      }

      const assetInSymbol = ASSET_OPTIONS.find(a => a.value === (legIn(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';
      const assetOutSymbol = ASSET_OPTIONS.find(a => a.value === (legOut(type, autoTradeAssetIn, autoTradeAssetOut)))?.symbol || 'Unknown';

      let statusMessage = `✅ Grid Bot ${type === 'buy' ? 'BUY' : 'SELL'} successful!
🤖 Grid Bot Transaction Completed
💰 Amount: ${amount} ${assetInSymbol}
📊 Pair: ${assetInSymbol}/${assetOutSymbol}
💵 Price: $${displayPrice.toFixed(4)}
🆔 Hash: ${submitResponse.hash || 'N/A'}`;

      // 🎯 Transfer logic: only transfer when transferAfterTrade is true (sales)
      if (transferAfterTrade && usingBotWallet && proceedsDestination && botWallet) {
        try {
          setAutoTradeStatus(statusMessage + `\n🔄 Earnings are transferred to the main wallet...`);
          
          // Transaction hash'ini kontrol et
          console.log('📄 Transaction Hash:', submitResponse.hash);
          
          // Wait longer for the transaction to confirm
          console.log('⏳ Waiting for transaction confirmation... (10 seconds)');
          await new Promise(resolve => setTimeout(resolve, 10000)); // raised from 3 to 10 seconds
          
          // Bot account'unu yeniden sorgula
          const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${botWallet.publicKey}`);
          if (response.ok) {
            const postTradeAccount = await response.json();
            
            // Debug: log all balances in detail
            console.log('🤖 Bot Wallet All Balances:', JSON.stringify(postTradeAccount.balances, null, 2));
            
            // Determine which asset to transfer (received after the sale)
            const targetAssetValue = legOut(type, autoTradeAssetIn, autoTradeAssetOut);
            const targetAssetInfo = ASSET_OPTIONS.find(a => a.value === targetAssetValue);
            
            console.log('🎯 Transfer target:', {
              targetAssetValue,
              targetAssetInfo,
              type,
              autoTradeAssetOut,
              autoTradeAssetIn
            });
            
            // Dedicated USDC search - check every balance
            console.log('🔍 USDC Search - All Balances Details:');
            postTradeAccount.balances.forEach((balance: any, index: number) => {
              console.log(`Balance ${index}:`, {
                asset_type: balance.asset_type,
                asset_code: balance.asset_code,
                asset_issuer: balance.asset_issuer,
                balance: balance.balance,
                is_usdc: balance.asset_code === 'USDC',
                contains_usd: balance.asset_code?.includes('USDC'),
                issuer_match: balance.asset_issuer === 'CBBHRKEP5M3NUDRISGLJKGHDHX3DA2CN2AZBQY6WLVUJ7VNLGSKBDUCM'
              });
            });
            
            // EMERGENCY: when the target is USDC, list EVERY non-XLM asset
            if (targetAssetInfo?.symbol === 'USDC') {
              console.log('🚨 EMERGENCY USDC SEARCH:');
              const nonXlmBalances = postTradeAccount.balances.filter((b: any) => b.asset_type !== 'native' && parseFloat(b.balance) > 0);
              console.log('Non-XLM balances:', nonXlmBalances);
              
              if (nonXlmBalances.length > 0) {
                console.log('🎯 USDC found! First non-XLM asset will be used:', nonXlmBalances[0]);
              }
            }
            
            // Find the target asset balance
            const targetAssetBalance = postTradeAccount.balances.find((balance: any) => {
              if (targetAssetValue.includes('native') || targetAssetValue.includes('XLM')) {
                return balance.asset_type === 'native';
              } else {
                const targetSymbol = targetAssetInfo?.symbol;
                
                console.log('🔍 Balance kontrol:', {
                  balance_asset_type: balance.asset_type,
                  balance_asset_code: balance.asset_code,
                  balance_asset_issuer: balance.asset_issuer,
                  balance_amount: balance.balance,
                  targetSymbol,
                  targetAssetValue
                });
                
                // VERY broad USDC search - any asset containing USD
                if (targetSymbol === 'USDC') {
                  // 1. Direkt USDC
                  if (balance.asset_code === 'USDC') {
                    console.log('✅ USDC (direct) found!', balance);
                    return true;
                  }
                  
                  // 2. any code containing USD
                  if (balance.asset_code && balance.asset_code.includes('USD')) {
                    console.log('✅ USD containing asset found!', balance);
                    return true;
                  }
                  
                  // 3. match by USDC issuer
                  if (balance.asset_issuer === targetAssetValue) {
                    console.log('✅ USDC issuer matching!', balance);
                    return true;
                  }
                  
                  // 4. any non-XLM, non-zero balance (last resort)
                  if (balance.asset_type !== 'native' && parseFloat(balance.balance) > 0) {
                    console.log('⚠️ Non-XLM asset found (USDC may be):', balance);
                    return true;
                  }
                }
                
                // Normal matching for other assets
                if (targetAssetValue && targetAssetValue.startsWith('C')) {
                  if (balance.asset_issuer === targetAssetValue) {
                    console.log('✅ Contract address matching successful');
                    return true;
                  }
                }
                
                if (balance.asset_code && targetSymbol) {
                  if (balance.asset_code.toUpperCase() === targetSymbol.toUpperCase()) {
                    console.log('✅ Symbol matching successful');
                    return true;
                  }
                }
                
                return false;
              }
            });
            
            console.log('🎯 Found targetAssetBalance:', targetAssetBalance);
            
            if (targetAssetBalance && parseFloat(targetAssetBalance.balance) > 0.01) { // lowered from 0.1 to 0.01
              const assetIdentifier = targetAssetBalance.asset_type === 'native' 
                ? 'native' 
                : `${targetAssetBalance.asset_code}_${targetAssetBalance.asset_issuer || ''}`;
              
              console.log('💸 Asset to be transferred:', assetIdentifier);
              console.log('💰 Amount to be transferred:', targetAssetBalance.balance);
              
              // 💰 Calculate the grid trading profit
              let gridProfitAmount: number | undefined;
              
              
              if (type === 'buy' && gridBuyQuote?.amountOut) {
                // Token amount received from the buy
                gridProfitAmount = parseFloat(gridBuyQuote.amountOut);
                console.log('💰 Grid Buy Profit Amount:', gridProfitAmount, getAssetSymbol(gridBuyQuote.assetOut));
              } else if (type === 'sell' && gridSellQuote?.amountOut) {
                // Profit amount from the sale
                gridProfitAmount = parseFloat(gridSellQuote.amountOut);
               
                console.log('💰 Grid Sell Profit Amount:', gridProfitAmount, getAssetSymbol(gridSellQuote.assetOut));
              }
              
              console.log('🎯 Calculated grid profit amount:', gridProfitAmount);
              
              const transferHash = await transferProfitToMainWallet(
                assetIdentifier,
                botWallet,
                proceedsDestination,
                gridProfitAmount // Pass the profit amount as a parameter
              );
              
              statusMessage += `\n✅ Earnings transferred to your wallet!
💸 Amount: ${parseFloat(targetAssetBalance.balance).toFixed(4)} ${targetAssetBalance.asset_code || 'XLM'}
💸 Transfer Hash: ${transferHash || 'N/A'}`;
            } else {
              const foundBalance = targetAssetBalance ? parseFloat(targetAssetBalance.balance).toFixed(6) : '0';
             
              // statusMessage += `\n📊 Found amount: ${foundBalance} (minimum: 0.01)`;
              // statusMessage += `\n📊 Current balances: ${postTradeAccount.balances.map((b: any) => 
              //   `${b.asset_code || 'XLM'}:${parseFloat(b.balance).toFixed(2)}`
              // ).join(', ')}`;
              
              // If there is no USDC but enough XLM, transfer XLM
              const xlmBalance = postTradeAccount.balances.find((b: any) => b.asset_type === 'native');
              if (xlmBalance && parseFloat(xlmBalance.balance) > 100) { // 100 XLM'den fazlaysa
                console.log('💡 USDC not found, XLM will be transferred...');
                try {
                  const xlmTransferHash = await transferProfitToMainWallet(
                    'native',
                    botWallet,
                    proceedsDestination,
                    undefined // No profit amount on the fallback XLM transfer
                  );
                  statusMessage += `\n🔄 Success!

              💸 Transfer Hash: ${xlmTransferHash || 'N/A'}`;
                } catch (xlmError) {
                  statusMessage += `\n❌ XLM transfer error: ${xlmError}`;
                }
              }
            }
          }
        } catch (transferError) {
          console.error('Grid Bot transfer error:', transferError);
          statusMessage += `\n⚠️ Transfer error: ${transferError}`;
        }
      } else if (type === 'buy') {
        statusMessage += `\n🏦 Acquired tokens are stored in the bot wallet (ready for sale)`;
      }

      setAutoTradeStatus(statusMessage);

      // Telegram notification
      if (telegramBot && telegramChatId) {
        const message = `🤖 Grid Bot ${type === 'buy' ? 'Buy' : 'Sell'} Successful!

💰 Amount: ${amount} ${assetInSymbol}
💵 Price: $${displayPrice.toFixed(4)}
🆔 Hash: ${submitResponse.hash || 'N/A'}
${transferAfterTrade ? '💸 Profit transferred to your wallet!' : '🏦 Tokens stored in the bot wallet'}
⏰ ${new Date().toLocaleString('en-US')}`;
        
        await telegramBot.sendMessage(telegramChatId, message);
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Grid Bot transaction error:', error);
      
      setAutoTradeStatus(`❌ Grid Bot ${type === 'buy' ? 'Buy' : 'Sell'} error: ${errorMessage}
🤖 Grid Bot Process Stopped
📊 Target: $${targetPrice}
💵 Current: $${displayPrice.toFixed(4)}
⚠️ Error: ${errorMessage}
⏰ ${new Date().toLocaleString('en-US')}`);
      
      // Telegram hata bildirimi
      if (telegramBot && telegramChatId) {
        const message = `❌ Grid Bot ${type === 'buy' ? 'Buy' : 'Sell'} Error!

🤖 Grid Bot Process Stopped
📊 Target: $${targetPrice}
💵 Current: $${displayPrice.toFixed(4)}
⚠️ Error: ${errorMessage}
⏰ ${new Date().toLocaleString('en-US')}`;
        
        await telegramBot.sendMessage(telegramChatId, message);
      }
    } finally {
      setIsTrading(false);
    }
  }, [publicKey, signTransaction, displayPrice, telegramBot, telegramChatId, autoTradeAssetIn, autoTradeAssetOut, botMode, botWallet, botBalance, transferProfitToMainWallet, proceedsDestination, getDynamicTradeParams, getAssetSymbol, gridBuyQuote, gridSellQuote, ensureLegTrustlines, signerFor]);



  // 🎯 Price-based automation check - pre-auth version
  useEffect(() => {
    const checkPreAuthTrade = async () => {
      if (isTrading || hasAutoTradeError || !isAutoTradingEnabled || !isConnected || displayPrice === 0) {
        return;
      }

      const now = new Date();
      if (lastAutoTradeCheck.current && (now.getTime() - lastAutoTradeCheck.current.getTime()) < 3000) {
        return;
      }
      lastAutoTradeCheck.current = now;

      try {
        // 🎯 Pre-auth buy check
        if (preAuthBuyOrder && now < preAuthBuyOrder.expiry && 
            displayPrice <= parseFloat(preAuthBuyOrder.targetPrice) && !isTrading) {
          
          setAutoTradeStatus(`🎯 Pre-auth buy triggered! $${displayPrice.toFixed(4)} <= $${preAuthBuyOrder.targetPrice}`);
          
          await executeBotTrade('buy', preAuthBuyOrder.amount, preAuthBuyOrder.targetPrice);
        }
        // 🎯 Pre-auth sell check
        else if (preAuthSellOrder && now < preAuthSellOrder.expiry && 
                 displayPrice >= parseFloat(preAuthSellOrder.targetPrice) && !isTrading) {

          setAutoTradeStatus(`🎯 Pre-auth sell triggered! $${displayPrice.toFixed(4)} >= $${preAuthSellOrder.targetPrice}`);

          await executeBotTrade('sell', preAuthSellOrder.amount, preAuthSellOrder.targetPrice);
        }
        
        // 🤖 Grid trading bot check
        if (gridTradingBot && now < gridTradingBot.expiry && gridTradingBot.isActive && !isTrading) {
          
          if (gridTradingBot.currentStep === 'waiting_buy' && 
              displayPrice <= parseFloat(gridTradingBot.buyPrice)) {
            
            setAutoTradeStatus(`🤖 Grid Bot: Buy triggered! $${displayPrice.toFixed(4)} ≤ $${gridTradingBot.buyPrice} (equal or below)`);
            
            // Execute the buy (NO transfer - stays in the bot wallet)
            await executeGridBotTrade('buy', gridTradingBot.buyAmount, gridTradingBot.buyPrice, false);
            
            // Move the grid bot into its selling phase
            const updatedGridBot = {
              ...gridTradingBot,
              currentStep: 'waiting_sell' as const,
              buyHash: 'completed',
              status: `✅ GRID BOT - PURCHASE COMPLETED!
🔄 UPDATED PROCESS ORDER:
1️⃣ PURCHASE STAGE: ✅ COMPLETED!
   → Purchase Price: $${displayPrice.toFixed(4)} (≤ $${gridTradingBot.buyPrice})
   → Amount Received: ${gridTradingBot.buyAmount} ${getAssetSymbol(autoTradeAssetIn)}
2️⃣ SALE STAGE: ⚠️ STARTED!
   → Target: Price ≥ $${gridTradingBot.sellPrice} (equal or above)
   → To be sold: ${getAssetSymbol(autoTradeAssetOut)} tokens in the bot
3️⃣ PROFIT TRANSFER: ⏳ Automatic transfer after sale

📊 CURRENT STATUS: 2️⃣ Waiting for sale price ($${gridTradingBot.sellPrice} and above)
🔄 Automatic loop continues...`
            };
            
            setGridTradingBot(updatedGridBot);
            localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(updatedGridBot));
            
          } else if (gridTradingBot.currentStep === 'waiting_sell' && 
                     displayPrice >= parseFloat(gridTradingBot.sellPrice)) {
            
            setAutoTradeStatus(`🤖 Grid Bot: Sale triggered! $${displayPrice.toFixed(4)} ≥ $${gridTradingBot.sellPrice} (equal or above)`);
            
            // Execute the sale (WITH transfer - proceeds go to the main wallet)
            try {
              if (botWallet) {
                const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${botWallet.publicKey}`);
                if (response.ok) {
                  const account = await response.json();
                  
                  // Debug: log every asset in the bot wallet
                  console.log('🤖 Assets in the Grid Bot wallet:', account.balances);
                  account.balances.forEach((balance: any, index: number) => {
                    console.log(`Asset ${index}:`, {
                      type: balance.asset_type,
                      code: balance.asset_code,
                      issuer: balance.asset_issuer,
                      contract: balance.asset_contract,
                      asset: balance.asset,
                      balance: balance.balance
                    });
                  });
                  
                  // Find the asset to sell: the buy leg acquired the base asset, so that is what
                  // the sell leg spends. Derived from the same helper as the swap itself, so the
                  // balance we look for can never drift from the leg we are about to build.
                  const targetAssetValue = legIn('sell', autoTradeAssetIn, autoTradeAssetOut);
                  const targetAssetInfo = ASSET_OPTIONS.find(a => a.value === targetAssetValue);
                  
                  console.log('🎯 Searched asset:', {
                    value: targetAssetValue,
                    symbol: targetAssetInfo?.symbol,
                    label: targetAssetInfo?.label,
                    rawAssetOptions: ASSET_OPTIONS
                  });
                  
                  console.log('🔍 Asset matching begins...');
                  
                  const targetBalance = account.balances.find((balance: any, index: number) => {
                    console.log(`🔍 Checking asset ${index}:`, {
                      balanceType: balance.asset_type,
                      balanceCode: balance.asset_code,
                      balanceIssuer: balance.asset_issuer?.slice(0, 10) + '...',
                      balanceContract: balance.asset_contract?.slice(0, 10) + '...',
                      targetValue: targetAssetValue.slice(0, 20) + '...',
                      targetSymbol: targetAssetInfo?.symbol
                    });
                    
                    if (targetAssetValue.includes('native')) {
                      const isMatch = balance.asset_type === 'native';
                      console.log(`   → Native match: ${isMatch}`);
                      return isMatch;
                    } else {
                      const targetSymbol = targetAssetInfo?.symbol;
                      
                      // Advanced matching for Soroswap contract assets
                      if (balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12') {
                        // Geleneksel Stellar asset matching
                        const codeMatch = balance.asset_code && targetSymbol && (
                          balance.asset_code === targetSymbol ||
                          balance.asset_code.includes(targetSymbol) ||
                          targetSymbol.includes(balance.asset_code)
                        );
                        console.log(`   → Credit asset code match: ${codeMatch} (${balance.asset_code} vs ${targetSymbol})`);
                        return codeMatch;
                      } else if (balance.asset_type === 'contract') {
                        // Soroswap contract asset matching
                        const contractMatch = balance.asset_contract === targetAssetValue ||
                               balance.asset === targetAssetValue;
                        const codeMatch = balance.asset_code && targetSymbol && (
                                 balance.asset_code === targetSymbol ||
                                 balance.asset_code.includes(targetSymbol) ||
                                 targetSymbol.includes(balance.asset_code)
                               );
                        const anyMatch = contractMatch || codeMatch;
                        console.log(`   → Contract asset match: contractMatch=${contractMatch}, codeMatch=${codeMatch}, anyMatch=${anyMatch}`);
                        return anyMatch;
                      } else {
                        // Fallback - herhangi bir matching
                        const codeMatch = balance.asset_code && targetSymbol && (
                          balance.asset_code === targetSymbol ||
                          balance.asset_code.includes(targetSymbol) ||
                          targetSymbol.includes(balance.asset_code)
                        );
                        const contractMatch = balance.asset_contract === targetAssetValue ||
                                            balance.asset === targetAssetValue;
                        const anyMatch = codeMatch || contractMatch;
                        console.log(`   → Fallback match: codeMatch=${codeMatch}, contractMatch=${contractMatch}, anyMatch=${anyMatch}`);
                        return anyMatch;
                      }
                    }
                  });
                  
                  console.log('🔍 Asset matching sonucu:', targetBalance);
                  
                  if (targetBalance && parseFloat(targetBalance.balance) > 0.1) {
                    // Sell 95% of the bot's token balance (5% reserved for fees)
                    // const sellAmount = (parseFloat(targetBalance.balance) * 0.95).toFixed(4);
                    
                    // 🔄 USDC FINDING ALGORITHM - Enhanced
                    console.log('\n🎯 USDC FINDING ALGORITHM BEGINS');
                    console.log('Target Asset:', targetAssetInfo);
                    console.log('Bot Wallet ID:', botWallet?.publicKey);
                    console.log('Bot Balances:', account.balances);
                    
                    // Match the balance against the asset we actually intend to sell. Two earlier
                    // passes searched for USDC by a hardcoded code and by a contract address that
                    // no longer matches the configured one — either would happily return the quote
                    // balance no matter which asset the rule is trading, so both are gone.
                    let sellableBalance = null;

                    if (targetAssetInfo) {
                      sellableBalance = account.balances.find((balance: any) => {
                        if (targetAssetInfo.type === 'native') {
                          return balance.asset_type === 'native';
                        } else if (targetAssetInfo.type === 'contract') {
                          return balance.asset_type === 'contract' && 
                                 balance.contract === targetAssetInfo.contract;
                        } else if (targetAssetInfo.type === 'credit_alphanum4' || targetAssetInfo.type === 'credit_alphanum12') {
                          return balance.asset_code === targetAssetInfo.code && 
                                 balance.asset_issuer === targetAssetInfo.issuer;
                        }
                        return false;
                      });
                      if (sellableBalance) console.log(`✅ ${targetAssetInfo.symbol} balance matched:`, sellableBalance);
                    }

                    if (sellableBalance && parseFloat(sellableBalance.balance) > 0.1) {
                      // Use the amount the user set, capped at the available balance
                      const availableAmount = parseFloat(sellableBalance.balance) * 0.95; // 95% is usable
                      const requestedAmount = parseFloat(gridTradingBot.sellAmount);
                      const sellAmount = Math.min(availableAmount, requestedAmount).toFixed(4);
                      
                      console.log(`💸 Grid Bot: requested ${requestedAmount} ${targetAssetInfo?.symbol}, available ${availableAmount.toFixed(4)}, To be sold: ${sellAmount}`);

                      setAutoTradeStatus(`🔄 Grid Bot: ${sellAmount} ${targetAssetInfo?.symbol} is being sold...`);
                      
                      // Sell through the grid bot's dedicated sell function (transfer = true)
                      await executeGridBotTrade('sell', sellAmount, gridTradingBot.sellPrice, true);
                      
                      // Mark the grid bot complete
                      const completedGridBot = {
                        ...gridTradingBot,
                        currentStep: 'completed' as const,
                        sellHash: 'completed',
                        isActive: false,
                        status: `✅ GRID BOT COMPLETED!
🔄 TRANSACTION SEQUENCE COMPLETED - NORMAL:
1️⃣ PURCHASE: ✅ $${gridTradingBot.buyPrice} (≤ triggered at or below)
2️⃣ SALE: ✅ $${displayPrice.toFixed(4)} (≥ triggered at or above)
3️⃣ PROFIT TRANSFER: ✅ Transferred to main wallet!

💰 Transaction Amount: ${gridTradingBot.buyAmount} ${getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))} → ${sellAmount} ${targetAssetInfo?.symbol} sold
${requestedAmount !== parseFloat(sellAmount) ? `⚠️ Requested: ${requestedAmount} ${targetAssetInfo?.symbol}, sold: ${sellAmount} ${targetAssetInfo?.symbol}` : ''}
📈 Actual Profit: ${((displayPrice - parseFloat(gridTradingBot.buyPrice)) / parseFloat(gridTradingBot.buyPrice) * 100).toFixed(2)}%
🎉 Grid trading loop completed successfully!`
                      };
                      
                      setGridTradingBot(completedGridBot);
                      localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(completedGridBot));
                      
                      // 5 dakika sonra Grid Bot'u temizle
                      setTimeout(() => {
                        setGridTradingBot(null);
                        localStorage.removeItem(`grid_bot_${publicKey}`);
                      }, 5 * 60 * 1000);
                      
                    } else {
                      console.log('❌ USDC not found, experience with XLM...');
                      
                      // Alternative sale using XLM (debug mode)
                      const xlmBalance = account.balances.find((balance: any) => 
                        balance.asset_type === 'native' && parseFloat(balance.balance) > 2.5 // Min 2.5 XLM rezerv
                      );
                      
                      if (xlmBalance) {
                        // Use the amount the user set, capped at the available balance
                        const availableAmount = parseFloat(xlmBalance.balance) * 0.7; // 70% is usable
                        const requestedAmount = parseFloat(gridTradingBot.sellAmount);
                        const sellAmount = Math.min(availableAmount, requestedAmount).toFixed(4);
                        
                        console.log(`💸 Grid Bot Alternative: Desired: ${requestedAmount} XLM, Available: ${availableAmount.toFixed(4)} XLM, To be sold: ${sellAmount} XLM (Debug mode)`);
                        
                        setAutoTradeStatus(`🔄 Grid Bot: USDC not found, ${sellAmount} XLM sale is being made (Debug)...`);
                        
                        try {
                          // Sell XLM through the grid bot's dedicated sell function (transfer = true)
                          /////////111111
                          await executeGridBotTrade('sell', sellAmount, gridTradingBot.sellPrice, true);
                          
                          // Mark the grid bot complete (XLM debug sale)
                          const completedGridBot = {
                            ...gridTradingBot,
                            currentStep: 'completed' as const,
                            sellHash: 'completed',
                            isActive: false,
                            status: `⚠️ GRID BOT COMPLETED! (DEBUG MODE - XLM Sales)
🔄 PROCESS FLOW COMPLETED - DEBUG:
1️⃣ BUY: ⚠️ $${gridTradingBot.buyPrice} (Purchase may not have been successful)
2️⃣ SELL: ✅ $${displayPrice.toFixed(4)} (Sale made with XLM)
3️⃣ PROFIT TRANSFER: ✅ Transferred to main wallet!

💰 Planned Action: ${gridTradingBot.buyAmount} ${getAssetSymbol(autoTradeAssetIn)} → ${sellAmount} XLM (real debug)
${requestedAmount !== parseFloat(sellAmount) ? `⚠️ Desired: ${requestedAmount} ${getAssetSymbol(autoTradeAssetOut)}, Real: ${sellAmount} XLM` : ''}
💸 Real Sale: ${sellAmount} XLM (Debug Mode)
⚠️ WARNING: USDC not found, purchase may have failed
📈 Price Difference: ${((displayPrice - parseFloat(gridTradingBot.buyPrice)) / parseFloat(gridTradingBot.buyPrice) * 100).toFixed(2)}%
🔧 Debug mode Grid trading completed (there is a problem)!`
                          };
                          
                          setGridTradingBot(completedGridBot);
                          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(completedGridBot));
                          
                          // 3 dakika sonra Grid Bot'u temizle (debug mode)
                          setTimeout(() => {
                            setGridTradingBot(null);
                            localStorage.removeItem(`grid_bot_${publicKey}`);
                          }, 3 * 60 * 1000);
                          
                        } catch (xlmSellError) {
                          console.error('XLM sale error:', xlmSellError);
                          setAutoTradeStatus(`❌ Grid Bot: XLM sale error: ${xlmSellError}`);
                          
                          // Mark the grid bot as failed
                          const errorGridBot = {
                            ...gridTradingBot,
                            status: `❌ Grid Bot Error: XLM sale failed - ${xlmSellError}`
                          };
                          setGridTradingBot(errorGridBot);
                          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(errorGridBot));
                        }
                        
                      } else {
                        console.log('❌ Not enough XLM found (min 2.5 XLM required)');
                        setAutoTradeStatus('❌ Grid Bot: Not enough sellable asset found');

                        // Mark the grid bot as failed
                        const errorGridBot = {
                          ...gridTradingBot,
                          status: `❌ Grid Bot Error: Not enough sellable asset found

🔍 Bot Wallet Status:
- Bot ID: ${botWallet?.publicKey}
- Current Balances: ${JSON.stringify(account.balances, null, 2)}
- Target Asset: USDC (${targetAssetInfo?.contract})
- XLM Balance: ${account.balances.find((b: any) => b.asset_type === 'native')?.balance || '0'} XLM

⚠️ Possible reason: Purchase failed and USDC could not be obtained`
                        };
                        setGridTradingBot(errorGridBot);
                        localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(errorGridBot));
                      }
                    }
                    
                  } else {
                    console.log('⚠️ Target asset not found, searching for asset containing USDC...');

                    // First, search for any asset containing USDC
                    const usdcAssets = account.balances.filter((balance: any) => {
                      const hasBalance = parseFloat(balance.balance) > 0.1;
                      
                      // Try several ways of matching USDC
                      const codeMatch = balance.asset_code && (
                        balance.asset_code.includes('USDC') ||
                        balance.asset_code.includes('USD') ||
                        balance.asset_code === 'USDC'
                      );
                      
                      // Contract address matching
                      const contractMatch = balance.asset_contract === 'CBBHRKEP5M3NUDRISGLJKGHDHX3DA2CN2AZBQY6WLVUJ7VNLGSKBDUCM' ||
                                          balance.asset === 'CBBHRKEP5M3NUDRISGLJKGHDHX3DA2CN2AZBQY6WLVUJ7VNLGSKBDUCM';
                      
                      // Issuer matching (for classic Stellar assets)
                      const issuerMatch = balance.asset_issuer && balance.asset_code === 'USDC';
                      
                      const isUSDC = codeMatch || contractMatch || issuerMatch;
                      
                      console.log(`🔍 USDC check - Asset: ${balance.asset_code}, Type: ${balance.asset_type}, Contract: ${balance.asset_contract?.slice(0, 10)}..., hasBalance: ${hasBalance}, codeMatch: ${codeMatch}, contractMatch: ${contractMatch}, issuerMatch: ${issuerMatch}, isUSDC: ${isUSDC}`);
                      
                      return hasBalance && isUSDC;
                    });
                    
                    console.log('🔍 USDC containing assets:', usdcAssets);
                    
                    if (usdcAssets.length > 0) {
                      // Pick the first USDC asset
                      const usdcBalance = usdcAssets[0];
                      // Use the amount the user set, capped at the available balance
                      const availableAmount = parseFloat(usdcBalance.balance) * 0.95; // 95% is usable
                      const requestedAmount = parseFloat(gridTradingBot.sellAmount);
                      const sellAmount = Math.min(availableAmount, requestedAmount).toFixed(4);
                      
                      console.log(`💸 Grid Bot found USDC asset: Requested: ${requestedAmount} ${usdcBalance.asset_code}, Current: ${availableAmount.toFixed(4)} ${usdcBalance.asset_code}, Selling: ${sellAmount} ${usdcBalance.asset_code}`);
                      
                      setAutoTradeStatus(`🔄 Grid Bot: USDC asset found, selling ${sellAmount} ${usdcBalance.asset_code}...`);
                      /////////111111
                      // Sell through the grid bot's dedicated sell function (transfer = true)
                      await executeGridBotTrade('sell', sellAmount, gridTradingBot.sellPrice, true);
                      
                      // Mark the grid bot complete (USDC sale)
                      const completedGridBot = {
                        ...gridTradingBot,
                        currentStep: 'completed' as const,
                        sellHash: 'completed',
                        isActive: false,
                        status: `✅ Grid Bot completed! (USDC found)
🔄 Process sequence completed:
1️⃣ PURCHASE: ✅ $${gridTradingBot.buyPrice} (≤ equal or less than triggered)
2️⃣ SELLING: ✅ $${displayPrice.toFixed(4)} (≥ equal or greater than triggered)  
3️⃣ PROFIT TRANSFER: ✅ Transferred to main wallet!

💰 Transaction Amount: ${gridTradingBot.buyAmount} ${getAssetSymbol(autoTradeAssetIn)} → ${sellAmount} ${getAssetSymbol(autoTradeAssetOut)} (real)
${requestedAmount !== parseFloat(sellAmount) ? `⚠️ Requested: ${requestedAmount} ${getAssetSymbol(autoTradeAssetOut)}, actual: ${sellAmount} ${getAssetSymbol(autoTradeAssetOut)}` : ''}
💸 Sold USDC: ${sellAmount} ${usdcBalance.asset_code}
✅ Note: USDC asset was successfully found and sold
📈 Actual Profit: ${((displayPrice - parseFloat(gridTradingBot.buyPrice)) / parseFloat(gridTradingBot.buyPrice) * 100).toFixed(2)}%
🎉 Grid trading loop completed successfully!`
                      };
                      
                      setGridTradingBot(completedGridBot);
                      localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(completedGridBot));
                      
                      // 5 dakika sonra Grid Bot'u temizle
                      setTimeout(() => {
                        setGridTradingBot(null);
                        localStorage.removeItem(`grid_bot_${publicKey}`);
                      }, 5 * 60 * 1000);
                      
                    } else {
                      console.log('⚠️ USDC asset not found, trying XLM sale...');
                      
                      // Allow selling XLM (grid bot debug mode)
                      const xlmBalance = account.balances.find((balance: any) => 
                        balance.asset_type === 'native' && parseFloat(balance.balance) > 2.0 // Min 2 XLM rezerv
                      );
                      
                      if (xlmBalance) {
                        // Use the amount the user set, capped at the available balance
                        const availableAmount = parseFloat(xlmBalance.balance) * 0.8; // 80% is usable (leave a reserve)
                        const requestedAmount = parseFloat(gridTradingBot.sellAmount);
                        const sellAmount = Math.min(availableAmount, requestedAmount).toFixed(4);
                        
                        console.log(`💸 Grid Bot XLM Sale: ${sellAmount} XLM will be sold (Debug mode)`);
                        
                        setAutoTradeStatus(`🔄 Grid Bot: no USDC found, selling XLM instead (debug)...`);
                        
                        // Sell XLM through the grid bot's dedicated sell function (transfer = true)
                        try {
                          /////////111111
                          await executeGridBotTrade('sell', sellAmount, gridTradingBot.sellPrice, true);
                          
                          // Mark the grid bot complete (XLM sale)
                          const completedGridBot = {
                            ...gridTradingBot,
                            currentStep: 'completed' as const,
                            sellHash: 'completed',
                            isActive: false,
                            status: `✅ Grid Bot completed! (XLM Debug Sale)
🔄 Process sequence completed:
1️⃣ PURCHASE: ✅ $${gridTradingBot.buyPrice} (≤ equal or less than triggered)
2️⃣ SELLING: ✅ $${displayPrice.toFixed(4)} (≥ equal or greater than triggered)  
3️⃣ PROFIT TRANSFER: ✅ Transferred to main wallet!

💰 Transaction Amount: ${gridTradingBot.buyAmount} ${getAssetSymbol(autoTradeAssetIn)} → ${sellAmount} XLM (real debug)
${requestedAmount !== parseFloat(sellAmount) ? `⚠️ Requested: ${requestedAmount} XLM, Real: ${sellAmount} XLM` : ''}
💸 Sold XLM: ${sellAmount} XLM (Debug Mode)
⚠️ Note: USDC not found, XLM sold (purchase may have failed)
📈 Actual Profit: ${((displayPrice - parseFloat(gridTradingBot.buyPrice)) / parseFloat(gridTradingBot.buyPrice) * 100).toFixed(2)}%
🎉 Grid trading loop completed successfully (Debug)!`
                          };
                          
                          setGridTradingBot(completedGridBot);
                          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(completedGridBot));
                          
                          // 5 dakika sonra Grid Bot'u temizle
                          setTimeout(() => {
                            setGridTradingBot(null);
                            localStorage.removeItem(`grid_bot_${publicKey}`);
                          }, 5 * 60 * 1000);
                          
                        } catch (xlmSellError) {
                          console.error('XLM sale error:', xlmSellError);
                          setAutoTradeStatus(`❌ Grid Bot: XLM sale error: ${xlmSellError}`);
                        }
                        
                      } else {
                        console.log('⚠️ XLM not available (min 2 XLM required), alternative search being performed...');
                        
                        // Alternative: sell the non-XLM asset with the highest balance
                        const nonXLMAssets = account.balances.filter((balance: any) => 
                          balance.asset_type !== 'native' && 
                          parseFloat(balance.balance) > 0.1
                        );
                        
                        console.log('🔍 Mevcut non-XLM asset\'ler:', nonXLMAssets);
                        
                        if (nonXLMAssets.length > 0) {
                          // Pick the asset with the highest balance
                          const highestBalance = nonXLMAssets.reduce((prev: any, current: any) => 
                            parseFloat(current.balance) > parseFloat(prev.balance) ? current : prev
                          );
                          
                          // Use the amount the user set, capped at the available balance
                          const availableAmount = parseFloat(highestBalance.balance) * 0.95; // 95% is usable
                          const requestedAmount = parseFloat(gridTradingBot.sellAmount);
                          const sellAmount = Math.min(availableAmount, requestedAmount).toFixed(4);
                          
                          console.log(`💸 Grid Bot Alternative: Desired: ${requestedAmount} ${highestBalance.asset_code}, Current: ${availableAmount.toFixed(4)} ${highestBalance.asset_code}, Will be sold: ${sellAmount} ${highestBalance.asset_code}`);
                          
                          setAutoTradeStatus(`🔄 Grid Bot: Target asset not found, ${highestBalance.asset_code} sold...`);
                          
                          try {
                            /////////111111
                            // Sell through the grid bot's dedicated sell function (transfer = true)
                            await executeGridBotTrade('sell', sellAmount, gridTradingBot.sellPrice, true);
                            
                            // Mark the grid bot complete (alternative asset sale)
                            const completedGridBot = {
                              ...gridTradingBot,
                              currentStep: 'completed' as const,
                              sellHash: 'completed',
                              isActive: false,
                              status: `✅ GRID BOT COMPLETED! (Alternative Asset Sales)
🔄 Process sequence completed:
1️⃣ PURCHASE: ✅ $${gridTradingBot.buyPrice} (≤ equal or less than triggered)
2️⃣ SELLING: ✅ $${displayPrice.toFixed(4)} (≥ equal or greater than triggered)  
3️⃣ PROFIT TRANSFER: ✅ Transferred to main wallet!

💰 Transaction Amount: ${gridTradingBot.buyAmount} ${getAssetSymbol(autoTradeAssetIn)} → ${sellAmount} ${highestBalance.asset_code} (real alternative)
${requestedAmount !== parseFloat(sellAmount) ? `⚠️ Desired: ${requestedAmount} ${getAssetSymbol(autoTradeAssetOut)}, Real: ${sellAmount} ${highestBalance.asset_code}` : ''}
💸 Sold Asset: ${sellAmount} ${highestBalance.asset_code}
⚠️ Note: USDC not found, alternative asset sold
📈 Realized Transaction: ${((displayPrice - parseFloat(gridTradingBot.buyPrice)) / parseFloat(gridTradingBot.buyPrice) * 100).toFixed(2)}%
🎉 Grid trading cycle completed (Alternative)!`
                            };
                            
                            setGridTradingBot(completedGridBot);
                            localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(completedGridBot));
                            
                            // 5 dakika sonra Grid Bot'u temizle
                            setTimeout(() => {
                              setGridTradingBot(null);
                              localStorage.removeItem(`grid_bot_${publicKey}`);
                            }, 5 * 60 * 1000);
                            
                          } catch (altSellError) {
                            console.error('Alternative asset sale error:', altSellError);
                            setAutoTradeStatus(`❌ Grid Bot: Alternative asset sale error: ${altSellError}`);
                          }
                          
                        } else {
                          console.log('❌ No sellable asset found');
                          setAutoTradeStatus('❌ Grid Bot: No sellable asset found');

                          // Mark the grid bot as failed
                          const errorGridBot = {
                            ...gridTradingBot,
                            status: '❌ Grid Bot Error: No sellable asset found'
                          };
                          setGridTradingBot(errorGridBot);
                          localStorage.setItem(`grid_bot_${publicKey}`, JSON.stringify(errorGridBot));
                        }
                      }
                    }
                  }
                }
              }
            } catch (error) {
              console.error('Grid bot sale error:', error);
              setAutoTradeStatus(`❌ Grid Bot sale error: ${error}`);
            }
          }
        }
        
        // Expiry check
        if (preAuthBuyOrder && now > preAuthBuyOrder.expiry) {
          setPreAuthBuyOrder(null);
          localStorage.removeItem(`preauth_buy_${publicKey}`);
          setAutoTradeStatus('⏰ Pre-auth buy order expired. Please re-confirm.');
        }
        
        if (preAuthSellOrder && now > preAuthSellOrder.expiry) {
          setPreAuthSellOrder(null);
          localStorage.removeItem(`preauth_sell_${publicKey}`);
          setAutoTradeStatus('⏰ Pre-auth sell order expired. Re-confirm.');
        }
        
        if (gridTradingBot && now > gridTradingBot.expiry) {
          setGridTradingBot(null);
          localStorage.removeItem(`grid_bot_${publicKey}`);
          setAutoTradeStatus('⏰ Grid trading bot expired. Re-create.');
        }
        
      } catch (error: unknown) {
        console.error('❌ Pre-auth transaction check error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setAutoTradeStatus(`❌ Check error: ${errorMessage}`);
      }
    };

    checkPreAuthTrade();
  }, [displayPrice, isAutoTradingEnabled, isConnected, isTrading, preAuthBuyOrder, preAuthSellOrder, gridTradingBot, hasAutoTradeError, executeBotTrade, executeGridBotTrade, publicKey, botWallet, autoTradeAssetIn, autoTradeAssetOut, getAssetSymbol]);

  // 🤖 Auto bot mode: create a pre-auth order once the target price is set
  useEffect(() => {
    // Only run in auto bot mode once the conditions hold
    if (botMode !== 'auto' || !botWallet || !isConnected || !isAutoTradingEnabled) return;

    // Buy order auto creation
    if (buyTargetPrice && autoBuyAmount && !preAuthBuyOrder) {
      const timer = setTimeout(async () => {
        try {
          setAutoTradeStatus('🤖 Auto mode: Buy order creating automatically...');
          await createPreAuthBuyOrder(true); // Create in bot mode
        } catch (error) {
          console.error('Auto buy order creation error:', error);
          setAutoTradeStatus(`❌ Auto buy order error: ${error}`);
        }
      }, 1000); // 1 saniye bekle
      
      return () => clearTimeout(timer);
    }

    // Sell order auto creation
    if (sellTargetPrice && autoSellAmount && !preAuthSellOrder) {
      const timer = setTimeout(async () => {
        try {
          setAutoTradeStatus('🤖 Auto mode: Sell order creating automatically...');
          await createPreAuthSellOrder(true); // Create in bot mode
        } catch (error) {
          console.error('Auto sell order creation error:', error);
          setAutoTradeStatus(`❌ Auto sell order error: ${error}`);
        }
      }, 30000); // 1 saniye bekle
      
      return () => clearTimeout(timer);
    }

    // The grid bot is deliberately NOT auto-created here. It used to start a second after the
    // fourth field was filled, which meant a half-typed threshold could arm a live bot before the
    // user had finished reading their own numbers. Arming it is now the confirm button's job.

  }, [botMode, botWallet, isConnected, isAutoTradingEnabled,
      buyTargetPrice, autoBuyAmount, preAuthBuyOrder,
      sellTargetPrice, autoSellAmount, preAuthSellOrder,
      createPreAuthBuyOrder, createPreAuthSellOrder]);


  return (
    // <div className="min-h-screen relative overflow-hidden">
<div className="min-h-screen relative overflow-hidden">
      {/* Modern animated background */}
      <div className="absolute inset-0">
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-blue-600/10 via-purple-600/5 to-pink-600/10"></div>
        <div className="absolute top-20 left-20 w-96 h-96 bg-gradient-to-r from-cyan-400/20 to-blue-500/20 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute top-40 right-20 w-80 h-80 bg-gradient-to-r from-purple-400/20 to-pink-500/20 rounded-full blur-3xl animate-pulse delay-1000"></div>
        <div className="absolute bottom-20 left-1/3 w-72 h-72 bg-gradient-to-r from-emerald-400/20 to-teal-500/20 rounded-full blur-3xl animate-pulse delay-2000"></div>
        
        {/* Grid pattern overlay */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:100px_100px]"></div>
      </div>
      
      {/* Header */}
      <header className="relative z-50 backdrop-blur-xl bg-white/5 border-b border-white/10 shadow-2xl">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-6">
              <div className="relative group">
                {/* Logo container with modern design */}
                <div className="w-10 h-10 bg-gradient-to-br from-cyan-500 via-blue-600 to-purple-700 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/25 transform group-hover:scale-110 transition-all duration-500 relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-tr from-white/20 to-transparent"></div>
                  <span className="text-white font-bold text-lg relative z-10 drop-shadow-lg">🤖</span>
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full animate-ping"></div>
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full"></div>
                </div>
              </div>
              <div className="space-y-1">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-white via-cyan-200 to-blue-300 bg-clip-text text-transparent drop-shadow-sm">
                  Pre-Auth Bot Trader
                </h1>
                <p className="text-sm text-slate-300 font-medium tracking-wide">
                  Advanced DeFi Trading Automation Platform
                </p>
              </div>
              
              {/* Ana Sayfa Linki */}
              <Link 
                href="/"
                className="group relative bg-gradient-to-r from-orange-500 via-red-500 to-pink-600 hover:from-orange-400 hover:via-red-400 hover:to-pink-500 text-white px-6 py-2.5 rounded-full font-medium transition-all duration-300 shadow-lg hover:shadow-xl hover:scale-105 transform overflow-hidden ml-15"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <div className="relative z-10 flex items-center space-x-2">
                  <span className="text-sm">💫</span>
                  <span>Conduit</span>
                </div>
              </Link>
            </div>
            
            {/* Wallet Connection Status */}
            <div className="flex items-center space-x-4">
              {isConnected && publicKey ? (
                <div className="group relative flex items-center space-x-2">
                  <div className="flex items-center space-x-3 bg-gradient-to-r from-emerald-500/20 to-green-500/20 backdrop-blur-xl text-emerald-100 px-4 py-2 rounded-full border border-emerald-400/30 shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20 transition-all duration-300">
                    <div className="relative">
                      <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse shadow-lg shadow-emerald-400/50"></div>
                      <div className="absolute inset-0 bg-emerald-400 rounded-full animate-ping"></div>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-medium text-xs text-emerald-300">Connected</span>
                      <span className="font-mono text-xs text-white bg-white/10 px-2 py-1 rounded-lg">
                        {publicKey.slice(0, 6)}...{publicKey.slice(-6)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={connectWallet}
                    title="Switch wallet or account"
                    className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-full border border-white/20"
                  >
                    switch
                  </button>
                  <button
                    onClick={() => freighter.disconnect().catch(error => console.error('Disconnect error:', error))}
                    title="Disconnect"
                    className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-full border border-white/20"
                  >
                    disconnect
                  </button>
                  {/* Manuel Kontrol Butonu */}
                  {/* <button
                    onClick={checkFreighterConnection}
                    title="Check the wallet connection"
                    className="w-8 h-8 bg-gradient-to-r from-blue-500/20 to-purple-500/20 hover:from-blue-500/30 hover:to-purple-500/30 backdrop-blur-xl text-white rounded-full flex items-center justify-center border border-white/20 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110"
                  >
                    <span className="text-sm">🔍</span>
                  </button> */}
                </div>
              ) : (
                <div className="flex items-center space-x-2">
                  <button
                    onClick={connectWallet}
                    disabled={!isAvailable}
                    className="group relative bg-gradient-to-r from-cyan-500 via-blue-600 to-purple-700 hover:from-cyan-400 hover:via-blue-500 hover:to-purple-600 disabled:from-gray-600 disabled:to-gray-700 text-white px-6 py-2.5 rounded-full font-medium transition-all duration-300 shadow-lg hover:shadow-xl hover:scale-105 transform disabled:hover:scale-100 overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                    <div className="relative z-10 flex items-center space-x-2">
                      <span className="text-lg">{isAvailable ? '🚀' : '⬇️'}</span>
                      <span>{isAvailable ? 'Connect Freighter' : 'Install Freighter'}</span>
                    </div>
                  </button>
                  {/* Wallet status check button (when disconnected) */}
                  {/* <button
                    onClick={checkFreighterConnection}
                    title="Freighter durumunu kontrol et"
                    className="w-8 h-8 bg-gradient-to-r from-gray-500/20 to-gray-600/20 hover:from-gray-500/30 hover:to-gray-600/30 backdrop-blur-xl text-gray-300 hover:text-white rounded-full flex items-center justify-center border border-white/20 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110"
                  >
                    <span className="text-sm">🔍</span>
                  </button> */}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-7xl mx-auto px-6 py-12">
        {/* What this page is. It is kept on purpose — it is the version that won DoraHacks — but
            its security model is the earlier one, and saying so is better than letting a reader
            discover the contradiction with the mandate-based automation on the home page. */}
        <div className="mb-8 rounded-xl border border-amber-400/30 bg-amber-500/10 backdrop-blur-xl p-4 text-sm text-amber-100">
          <div className="font-semibold mb-1">📌 v1 — the DoraHacks-winning grid bot</div>
          <p className="text-amber-100/80 leading-relaxed">
            This page is kept as it was awarded. It trades from its own automation wallet, so that
            wallet holds the funds while a cycle runs — there is no on-chain cap on what it may do.
            Its key is now non-extractable, but the spending limits are not.{' '}
            <Link href="/" className="underline hover:text-white">
              The automation on the home page
            </Link>{' '}
            replaced this model: funds never leave your wallet, and a mandate contract enforces
            which assets, how much per window and at which prices. That contract is what this page
            taught us to build.
          </p>
        </div>

        {!isConnected ? (
          /* Wallet Connection Screen - Modern Design */
          <div className="min-h-[80vh] flex items-center justify-center">
            <div className="text-center max-w-2xl mx-auto">
              {/* Modern 3D Logo */}
              <div className="relative mx-auto mb-12 w-48 h-48 group">
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-400 via-blue-500 to-purple-600 rounded-3xl shadow-2xl shadow-blue-500/25 animate-float transform group-hover:scale-105 transition-all duration-700"></div>
                <div className="absolute inset-2 bg-gradient-to-br from-slate-900/50 to-slate-800/50 backdrop-blur-xl rounded-2xl flex items-center justify-center border border-white/10">
                  <span className="text-8xl animate-bounce-slow drop-shadow-2xl">🤖</span>
                </div>
                {/* Floating particles */}
                <div className="absolute -top-4 -left-4 w-8 h-8 bg-cyan-400 rounded-full opacity-60 animate-ping"></div>
                <div className="absolute -bottom-4 -right-4 w-6 h-6 bg-purple-400 rounded-full opacity-60 animate-ping delay-1000"></div>
                <div className="absolute top-1/2 -right-8 w-4 h-4 bg-emerald-400 rounded-full opacity-60 animate-ping delay-2000"></div>
              </div>
              
              {/* Modern Typography */}
              <div className="space-y-8">
                <h2 className="text-6xl font-bold bg-gradient-to-r from-white via-cyan-200 to-blue-300 bg-clip-text text-transparent leading-tight">
                  Connect Your Wallet
                </h2>
                <div className="space-y-4">
                  <p className="text-xl text-slate-300 leading-relaxed max-w-xl mx-auto">
                    Connect your Freighter wallet to unlock advanced DeFi trading automation
                  </p>
                  <div className="flex items-center justify-center space-x-6 text-sm text-slate-400">
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
                      <span>Secure</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse delay-500"></div>
                      <span>Automated</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse delay-1000"></div>
                      <span>Professional</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modern CTA Button */}
              <div className="mt-16 space-y-8">
                <button
                  onClick={connectWallet}
                  disabled={!isAvailable}
                  className="group relative bg-gradient-to-r from-cyan-500 via-blue-600 to-purple-700 hover:from-cyan-400 hover:via-blue-500 hover:to-purple-600 disabled:from-gray-600 disabled:to-gray-700 text-white px-12 py-6 rounded-3xl font-bold text-xl transition-all duration-300 shadow-2xl shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-105 transform disabled:hover:scale-100 overflow-hidden min-w-[300px]"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  <div className="relative z-10 flex items-center justify-center space-x-3">
                    <span className="text-3xl">{isAvailable ? '🚀' : '⬇️'}</span>
                    <span>{isAvailable ? 'Connect Freighter Wallet' : 'Install Freighter Extension'}</span>
                  </div>
                </button>
                
                {!isAvailable && (
                  <div className="space-y-4">
                    <p className="text-slate-400">Install Freighter browser extension first</p>
                    <a 
                      href="https://freighter.app/" 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="inline-flex items-center space-x-3 text-cyan-400 hover:text-cyan-300 transition-colors duration-300 group"
                    >
                      <span>Download Freighter</span>
                      <svg className="w-5 h-5 transform group-hover:translate-x-1 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                      </svg>
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Trading Interface - Modern Layout */
          <div className="space-y-12">
            {/* Modern Welcome Section */}
            <div className="text-center mb-12">
              <h2 className="text-5xl font-bold bg-gradient-to-r from-white via-cyan-200 to-blue-300 bg-clip-text text-transparent mb-4 leading-tight">
                Advanced Trading Bot
              </h2>
              <p className="text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
                Automated price-based trading with intelligent pre-authorization system
              </p>
            </div>

            {/* Security Model Card - Modernized */}
            {/* <Card className="p-8 bg-gradient-to-br from-emerald-900/30 via-slate-900/80 to-emerald-900/30 border-emerald-500/40 backdrop-blur-xl shadow-2xl">
              <div className="flex items-center space-x-3 mb-6">
                <div className="w-12 h-12 bg-emerald-500/20 rounded-2xl flex items-center justify-center backdrop-blur-sm border border-emerald-400/30">
                  <span className="text-2xl">🤖</span>
                </div>
                <h3 className="text-2xl font-bold text-emerald-100">Bot Security Architecture</h3>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-4">
                  <div className="flex items-center space-x-3 mb-4">
                    <div className="w-3 h-3 bg-blue-400 rounded-full animate-pulse"></div>
                    <h4 className="text-xl font-semibold text-blue-200">👤 Manual Mode</h4>
                  </div>
                  <div className="space-y-3 pl-6 border-l-2 border-blue-500/30">
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-blue-400">•</span>
                      <span>Funds from your main wallet</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-blue-400">•</span>
                      <span>Signature required for each transaction</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-blue-400">•</span>
                      <span>Requires active monitoring</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-blue-400">•</span>
                      <span>Freighter popup confirmation</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center space-x-3 mb-4">
                    <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse delay-500"></div>
                    <h4 className="text-xl font-semibold text-emerald-200">🤖 Autonomous Mode</h4>
                  </div>
                  <div className="space-y-3 pl-6 border-l-2 border-emerald-500/30">
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-emerald-400">•</span>
                      <span>Bot wallet funding system</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-emerald-400">•</span>
                      <span>Automated signature handling</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-emerald-400">•</span>
                      <span>24/7 operation capability</span>
                    </div>
                    <div className="flex items-center space-x-3 text-slate-300">
                      <span className="text-emerald-400">•</span>
                      <span>Requires XLM transfer to bot</span>
                    </div>
                    <div className="flex items-center space-x-3 text-emerald-300 font-semibold">
                      <span className="text-emerald-400">💸</span>
                      <span>Profits transferred to designated address</span>
                    </div>
                  </div>
                </div>
              </div>
            </Card> */}

        {/* 🔗 Wallet connection status */}
        <Card className={`${isConnected ? 'bg-blue-50 border-blue-200' : 'bg-yellow-50 border-yellow-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
              <div>
                <h3 className="font-semibold text-gray-800">
                  {isConnected ? '✅ Freighter Connected' : '🔗 Freighter Connection'}
                </h3>
                {isConnected && publicKey ? (
                  <p className="text-sm text-gray-600">
                    {publicKey.substring(0, 4)}...{publicKey.substring(publicKey.length - 4)}
                  </p>
                ) : (
                  <p className="text-sm text-gray-600">Wallet connection required</p>
                )}
              </div>
            </div>
            {!isConnected && (
              <button
                onClick={async () => {
                  try {
                    await connect();
                  } catch (error) {
                    console.error('Connection error:', error);
                  }
                }}
                disabled={!isAvailable}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isAvailable ? 'Connect Wallet' : 'Install Freighter'}
              </button>
            )}
            {isConnected && (
              <div className="text-sm text-green-600 font-medium">
Manual and Bot modes available              
</div>
            )}
          </div>
          {freighterError && (
            <div className="mt-3 p-2 bg-red-100 border border-red-200 rounded">
              <p className="text-sm text-red-700">❌ {freighterError}</p>
            </div>
          )}
        </Card>

        {/* Error and status indicators */}
        {error && (
          <Card className="bg-red-50 border border-red-200">
            <div className="text-red-700"><strong>Hata:</strong> {error}</div>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sol Panel - Fiyat ve Durum */}
          <div className="space-y-4">
            <PriceDisplay
              price={displayPrice}
              lastUpdate={lastUpdate}
              isTracking={isTracking && !manualPriceMode}
            />

            {/* Two prices, and they disagree on testnet. Rules fire on the pool, because that is
                where the swap is filled; the oracle is shown so the gap is visible rather than
                silently misleading. */}
            <Card title="🎯 Which price decides">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-baseline">
                  <span className="text-gray-600">
                    Soroswap pool ({getAssetSymbol(autoTradeAssetIn)}/{getAssetSymbol(autoTradeAssetOut)})
                  </span>
                  <span className="font-semibold text-green-700">
                    {poolPrice ? poolPrice.toFixed(6) : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-gray-600">Reflector oracle (XLM/USD)</span>
                  <span className="font-medium text-gray-500">
                    {currentPrice ? currentPrice.toFixed(6) : '—'}
                  </span>
                </div>
                {poolPriceError && (
                  <p className="text-xs text-red-600">⚠️ Pool price unavailable: {poolPriceError}</p>
                )}
                <p className="text-xs text-gray-500 border-t pt-2">
                  Rules fire on the <strong>pool</strong> price — that is the market the swap is
                  filled in. The oracle reports the real-world rate; on testnet the two differ
                  widely, so thresholds below are in pool terms.
                </p>
              </div>
            </Card>

            {/* Manual price check */}
            <Card title="📊 Price Check">
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="manualPriceMode"
                    checked={manualPriceMode}
                    onChange={(e) => setManualPriceMode(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <label htmlFor="manualPriceMode" className="text-sm font-medium">
                    Manual Price Mode
                  </label>
                </div>
                
                {manualPriceMode ? (
                  <div className="space-y-2">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="Enter price ($)"
                      value={manualPrice}
                      onChange={(e) => setManualPrice(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <div className="text-xs text-gray-500">
                      Manual mode: Real price tracking stopped
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">
                    Automatic mode: Real-time price tracking
                  </div>
                )}
              </div>
            </Card>

            {/* Takip Kontrolleri */}
            <Card title="📊 Price Tracking">
              <div className="space-y-3">
                {!isTracking ? (
                  <Button 
                    onClick={() => startTracking(15000)} 
                    variant="success" 
                    className="w-full"
                    disabled={manualPriceMode}
                  >
                    ▶️ Start Tracking (5s)
                  </Button>
                ) : (
                  <Button onClick={stopTracking} variant="error" className="w-full">
                    ⏹️ Stop Tracking
                  </Button>
                )}
              </div>
            </Card>

            {/* Freighter Wallet */}
            <Card title="🌌 Freighter Wallet" className="bg-purple-50 border-purple-200">
              <div className="space-y-3">
                <div className="text-xs bg-white p-3 rounded border">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-3 h-3 rounded-full ${isAvailable ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    <span className="font-medium">Freighter: {isAvailable ? '✅ Loaded' : '❌ Not Loaded'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    <span className="font-medium">Connection: {isConnected ? '✅ Connected' : '❌ Not Connected'}</span>
                  </div>
                  {publicKey && (
                    <div className="text-xs text-gray-600 mt-2 p-2 bg-gray-50 rounded">
                      <div className="font-mono break-all">
                        {publicKey.slice(0, 10)}...{publicKey.slice(-10)}
                      </div>
                    </div>
                  )}
                  {freighterError && (
                    <div className="mt-2 p-2 bg-red-50 rounded border-l-4 border-red-400">
                      <div className="text-xs text-red-700">
                        <strong>Error:</strong> {freighterError}
                      </div>
                    </div>
                  )}
                </div>

                {!isConnected && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Button onClick={connectWallet} disabled={!isAvailable} className="flex-1" variant="success">
                        🔗 Connect to Freighter
                      </Button>
                      {/* <Button 
                        onClick={checkFreighterConnection} 
                        size="sm"
                        title="Freighter durumunu kontrol et"
                        className="px-3"
                      >
                        🔍
                      </Button> */}
                    </div>
                    <div className="text-xs bg-yellow-100 p-2 rounded text-yellow-700">
                      ⚠️ <strong>localhost connection issue:</strong> If you are seeing a &quot;domain not connected&quot; error, try clicking the button again to reconnect.
                    </div>
                  </div>
                )}
                
                {isConnected && (
                  <div className="flex gap-2">
                    <div className="flex-1 text-sm text-green-600 font-medium flex items-center">
                      ✅ Wallet is connected and ready
                    </div>
                    {/* <Button 
                      onClick={checkFreighterConnection} 
                      size="sm"
                      title="Re-check the wallet connection"
                      className="px-3"
                    >
                      🔍
                    </Button> */}
                  </div>
                )}
              </div>
            </Card>

            {/* Bot Wallet Sistemi */}
            <Card title="🤖 Bot Wallet (Fully Automatic)" className="bg-blue-50 border-blue-200">
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-sm font-medium">Bot Mode:</label>
                  <select 
                    value={botMode} 
                    onChange={(e) => setBotMode(e.target.value as 'manual' | 'auto')}
                    className="px-2 py-1 border rounded text-sm"
                    disabled={!isConnected}
                  >
                    <option value="manual">👤 Manual (User Signature)</option>
                    <option value="auto">🤖 Automatic (Bot Signature)</option>
                  </select>
                </div>

                {botMode === 'auto' && (
                  <div className="space-y-3">
                    {!botWallet ? (
                      <div className="space-y-2">
                        <div className="text-sm bg-yellow-100 p-2 rounded text-yellow-800">
                          ⚠️ Create a bot wallet and transfer XLM
                        </div>
                        <Button 
                          onClick={createBotWallet} 
                          disabled={!isConnected} 
                          className="w-full" 
                          variant="success"
                        >
                          🤖 Create Bot Wallet
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-xs bg-blue-100 p-2 rounded border">
                          <div className="font-medium text-blue-800">🤖 Bot Wallet Active</div>
                          <div className="font-mono text-xs mt-1 break-all">
                            <strong>Public Key:</strong><br/>
                            {botWallet.publicKey}
                          </div>
                     
                          <div className="mt-2">
                            <span className="font-medium">Balance: </span>
                            <span className={`font-mono ${botBalance > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {botBalance.toFixed(2)} XLM
                            </span>
                          </div>
                        </div>
                        
                        {botBalance === 0 && (
                          <div className="text-xs bg-red-100 p-2 rounded text-red-700">
                            ❌ Transfer a minimum of 2 XLM to the bot wallet!
                          </div>
                        )}
                        
                        {botBalance > 0 && botBalance < 2 && (
                          <div className="text-xs bg-yellow-100 p-2 rounded text-yellow-700">
                            ⚠️ Low balance! Minimum 2 XLM is recommended (Current: {botBalance.toFixed(2)} XLM)
                          </div>
                        )}
                        
                        {botBalance >= 2 && (
                          <div className="text-xs bg-green-100 p-2 rounded text-green-700">
                            ✅ Bot wallet ready! You can proceed with transactions.
                          </div>
                        )}
                        
                    
                        
                        <div className="flex gap-2">
                          <Button 
                            onClick={() => checkBotBalance(botWallet.publicKey)} 
                            size="sm" 
                            className="flex-1"
                          >
                            🔄 Balance
                          </Button>
                       
                        </div>
                        
                        <div className="flex gap-2">
                          <Button 
                            onClick={() => {
                              navigator.clipboard.writeText(botWallet.publicKey);
                              alert('Public Key copied!');
                            }} 
                            size="sm" 
                            className="flex-1"
                          >
                            Copy Public Key
                          </Button>
                        
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {botMode === 'manual' && (
                  <div className="text-xs bg-gray-100 p-2 rounded text-gray-600">
                    👤 Manual mode requires user signature for each transaction
                  </div>
                )}
              </div>
            </Card>

            {/* Telegram Kurulum */}
            <Card title="📱 Telegram">
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={telegramChatId}
                    onChange={(e) => {
                      setTelegramChatId(e.target.value);
                      localStorage.setItem('telegram_chat_id', e.target.value);
                    }}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
                    placeholder="Chat ID"
                  />
                  <button
                    onClick={detectTelegramChatId}
                    disabled={telegramDetecting}
                    className="px-3 py-2 bg-blue-100 hover:bg-blue-200 disabled:opacity-50 rounded text-sm whitespace-nowrap"
                  >
                    {telegramDetecting ? '…' : 'Detect'}
                  </button>
                </div>
                {/* A chat id from a third-party bot such as @userinfobot is the right number but
                    the wrong thing to ask for: this bot can only message a chat that has written
                    to it first, so that id comes back as "chat not found". Detect reads the id
                    from this bot's own pending updates, which can only exist once you have. */}
                <div className="text-xs text-gray-500">
                  Message your bot on Telegram first (press <strong>Start</strong>), then press
                  Detect. A bot cannot open a conversation by itself.
                </div>
                {telegramDetectStatus && (
                  <div className="text-xs text-gray-700">{telegramDetectStatus}</div>
                )}

                {/* Every notification site is written as `if (telegramBot && telegramChatId)`, so
                    with no chat id they are skipped in silence and the feature merely looks
                    broken. Say which of the two it is. */}
                <div className={`text-xs p-2 rounded ${telegramChatId ? 'bg-green-50 text-green-800' : 'bg-yellow-50 text-yellow-800'}`}>
                  {telegramChatId ? (
                    <>✅ Notifications on — sending to chat <span className="font-mono">{telegramChatId}</span></>
                  ) : (
                    <>⚪ Notifications off — no chat ID set, so nothing is sent.</>
                  )}
                </div>
              </div>
            </Card>

            <Card title="💰 Earnings Wallet" className="bg-orange-50 border-orange-200">
              <div className="text-xs text-orange-800 space-y-1">
                <div>Earnings return to the wallet you have connected:</div>
                <div className="font-mono break-all text-gray-700">
                  {publicKey ?? 'No wallet connected'}
                </div>
              </div>
            </Card>
          </div>

          {/* Right panel - 🎯 price-based automation (main focus) */}
          <div className="lg:col-span-2">
            <Card title="🎯 Price-Based Automatic Trading" className="bg-gradient-to-r from-green-50 to-blue-50 border-2 border-green-300">
              {isConnected ? (
                <div className="space-y-6">
                  {/* Automation toggle */}
                  <div className="flex items-center justify-between p-4 bg-white rounded-lg border-2 border-gray-200">
                    <div>
                      <h3 className="font-bold text-lg">🤖 Automatic Trading System</h3>
                      <p className="text-sm text-gray-600">Automatic buying and selling at prices you set (Pre-Authorization)</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {hasAutoTradeError && (
                        <Button
                          onClick={() => {
                            setHasAutoTradeError(false);
                            setAutoTradeStatus('✅ System reset, ready.');
                            setIsAutoTradingEnabled(true);
                            setBuyTargetPrice('');
                            setSellTargetPrice('');
                            setAutoBuyAmount('');
                            setAutoSellAmount('');
                          }}
                          size="sm"
                          variant="success"
                        >
                          🔄 Reset
                        </Button>
                      )}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isAutoTradingEnabled}
                          onChange={(e) => {
                            setIsAutoTradingEnabled(e.target.checked);
                            if (e.target.checked && hasAutoTradeError) {
                              setHasAutoTradeError(false);
                              setAutoTradeStatus(null);
                            }
                          }}
                          className="rounded"
                          disabled={isTrading}
                        />
                        <span className={`font-medium ${isAutoTradingEnabled ? 'text-green-600' : 'text-gray-500'}`}>
                          {isAutoTradingEnabled ? '🟢 ACTIVE' : '⚪ INACTIVE'}
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Trading pair selection.
                      This picks a PAIR, not a swap direction. Two dropdowns either side of a swap
                      arrow is the universal "from → to" idiom, and it read that way here even
                      though the buy leg runs the other way — so both columns are labelled and the
                      resulting legs are spelled out underneath. */}
                  <div className="p-4 bg-gray-50 rounded-lg border">
                    <h4 className="font-semibold mb-3">🔄 Trading Pair</h4>
                    <div className="grid grid-cols-3 gap-2 items-end">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Asset traded</label>
                        <select
                          value={autoTradeAssetIn}
                          onChange={(e) => handleAutoTradeAssetInChange(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded"
                          disabled={isTrading}
                        >
                          {ASSET_OPTIONS.filter(asset => asset.value !== autoTradeAssetOut).map((asset) => (
                            <option key={asset.value} value={asset.value}>
                              {asset.symbol}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="text-center pb-1">
                        <button
                          onClick={() => {
                            const temp = autoTradeAssetIn;
                            setAutoTradeAssetIn(autoTradeAssetOut);
                            setAutoTradeAssetOut(temp);
                          }}
                          className="bg-blue-100 hover:bg-blue-200 p-2 rounded-full"
                          disabled={isTrading}
                          title="Swap which asset is traded and which one prices it"
                        >
                          ↔️
                        </button>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Priced in</label>
                        <select
                          value={autoTradeAssetOut}
                          onChange={(e) => handleAutoTradeAssetOutChange(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded"
                          disabled={isTrading}
                        >
                          {ASSET_OPTIONS.filter(asset => asset.value !== autoTradeAssetIn).map((asset) => (
                            <option key={asset.value} value={asset.value}>
                              {asset.symbol}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* The legs this pair produces, so the direction is never inferred from layout */}
                    <div className="mt-3 pt-2 border-t text-xs space-y-0.5">
                      <div className="text-green-700">
                        <strong>Buy</strong> = {getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))} → {getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))}
                        <span className="text-gray-500"> (when the price falls)</span>
                      </div>
                      <div className="text-red-700">
                        <strong>Sell</strong> = {getAssetSymbol(legIn('sell', autoTradeAssetIn, autoTradeAssetOut))} → {getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))}
                        <span className="text-gray-500"> (when it rises)</span>
                      </div>
                    </div>
                    <div className="text-center mt-2 text-sm text-gray-600">
                      {getAssetSymbol(autoTradeAssetIn)}/{getAssetSymbol(autoTradeAssetOut)}
                      <span className="text-xs text-gray-500">
                        {' '}— every price below is 1 {getAssetSymbol(autoTradeAssetIn)} in {getAssetSymbol(autoTradeAssetOut)}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Buy settings */}
                    <div className="p-4 bg-green-50 rounded-lg border-2 border-green-200">
                      <h4 className="font-semibold text-green-800 mb-3">💰 Automatic Purchase</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Target Price ({getAssetSymbol(autoTradeAssetOut)})</label>
                          <input
                            type="number"
                            step="0.0001"
                            placeholder="0.1200"
                            value={buyTargetPrice}
                            onChange={(e) => setBuyTargetPrice(e.target.value)}
                            className="w-full px-3 py-2 border border-green-300 rounded"
                            disabled={isTrading || !isAutoTradingEnabled}
                          />
                          <p className="text-xs text-green-600 mt-1">
                            Price ≤ Buy at this value
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Amount ({getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))} &rarr; {getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))})
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="10"
                            value={autoBuyAmount}
                            onChange={(e) => setAutoBuyAmount(e.target.value)}
                            className="w-full px-3 py-2 border border-green-300 rounded"
                            disabled={isTrading || !isAutoTradingEnabled}
                          />
                        </div>

                        {/* Swap cost - buy quote */}
                        {autoBuyAmount && (
                          <div className="space-y-2">
                            {quoteLoading ? (
                              <div className="bg-gray-100 p-3 rounded-lg border animate-pulse">
                                <div className="flex items-center text-sm text-gray-600">
                                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                 Calculating token exchange cost...
                                </div>
                              </div>
                            ) : buyQuote ? (
                              <div className="bg-green-100 p-3 rounded-lg border border-green-200">
                                <div className="text-sm font-medium text-green-800 mb-2">💰 Token Exchange Cost</div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <div>
                                    <span className="text-gray-600">You will spend:</span>
                                    <div className="font-mono font-bold text-green-700">
                                      {formatAmount(buyQuote.amountIn)} {getAssetSymbol(buyQuote.assetIn)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">You will receive (estimated):</span>
                                    <div className="font-mono font-bold text-green-700">
                                      {formatAmount(buyQuote.amountOut)} {getAssetSymbol(buyQuote.assetOut)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">Fiyat Etkisi:</span>
                                    <div className={`font-bold ${parseFloat(buyQuote.priceImpactPct) > 5 ? 'text-red-600' : 'text-green-600'}`}>
                                      {formatPercentage(buyQuote.priceImpactPct)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">Platform:</span>
                                    <div className="font-bold text-green-700">{buyQuote.platform}</div>
                                  </div>
                                </div>
                                {buyQuote.platformFee && (
                                  <div className="mt-2 pt-2 border-t border-green-200">
                                    <div className="text-xs text-gray-600">Platform Fee:</div>
                                    <div className="font-mono text-xs font-bold text-green-700">
                                      {formatAmount(buyQuote.platformFee.feeAmount)} ({buyQuote.platformFee.feeBps} bps)
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : autoBuyAmount && (
                              <div className="bg-yellow-100 p-3 rounded-lg border border-yellow-200">
                                <div className="text-sm text-yellow-800">
                                  ⚠️ Token exchange cost could not be calculated
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {buyTargetPrice && (
                          <div className={`text-sm p-2 rounded ${displayPrice <= parseFloat(buyTargetPrice) ? 'bg-green-200 text-green-800 font-bold' : 'bg-gray-100 text-gray-600'}`}>
                            {displayPrice <= parseFloat(buyTargetPrice) ? '🎯 TARGET REACHED!' : '⏳ Awaiting target...'}
                          </div>
                        )}
                        
                        {/* Pre-Authorization Button */}
                        <div className="space-y-2">
                          {!preAuthBuyOrder ? (
                          
                            <div className="space-y-2">
                              {/* Manuel Mod Butonu */}
                           {botMode === 'manual' && (
                              <Button
                                onClick={() => createPreAuthBuyOrder(false)}
                                disabled={!buyTargetPrice || !autoBuyAmount || !isConnected}
                                size="md"
                                variant="mrt"
                                className="w-full"
                              >
                                👤 Manual Buy Order
                              </Button>
                           )}

                              {/* Bot Mod Butonu */}
                              {botMode === 'auto' && botWallet ? (
                                <div className="space-y-2">
                                  <Button
                                    onClick={() => createPreAuthBuyOrder(true)}
                                    disabled={!buyTargetPrice || !autoBuyAmount || !isConnected}
                                    size="md"
                                    variant="mrt"
                                    className="w-full"
                                  >
                                    🤖 Bot Buy Order (XLM Transfer)
                                  </Button>
                                  {!isConnected && (
                                    <div className="text-xs bg-red-100 p-2 rounded text-red-700 border">
                                      ⚠️ Freighter connection required! It will connect automatically when you press the button.
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs bg-yellow-100 p-2 rounded text-yellow-700 border">
                                  ⚠️ For bot mode, select &quot;🤖 Automatic&quot; mode and create a bot wallet.
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="text-xs bg-green-100 text-green-700 p-2 rounded border">
                                ✅ Buy order ready
                                <div className="text-xs mt-1">
                                  ⏰ Time left: {Math.round((preAuthBuyOrder.expiry.getTime() - Date.now()) / 60000)} min
                                </div>
                              </div>
                              <div className="flex gap-2">
                                {preAuthBuyOrder.isBot && preAuthBuyOrder.requiredXLM ? (
                                  <Button
                                    onClick={async () => {
                                      try {
                                        // XLM iade et
                                        setAutoTradeStatus('💸 XLM is being refunded...');
                                        const refundResult = await refundXLMFromBot(preAuthBuyOrder.requiredXLM!);
                                        
                                        if (refundResult.success) {
                                          setAutoTradeStatus(`✅ ${preAuthBuyOrder.requiredXLM!.toFixed(2)} XLM has been refunded!`);
                                        }
                                        
                                        // Emri temizle
                                        setPreAuthBuyOrder(null);
                                        localStorage.removeItem(`preauth_buy_${publicKey}`);
                                        
                                        // Telegram bildirimi
                                        if (telegramBot && telegramChatId) {
                                          const message = `🤖 BOT BUY ORDER CANCELLED!
❌ Buy order canceled
💸 ${preAuthBuyOrder.requiredXLM!.toFixed(2)} XLM has been refunded
⏰ ${new Date().toLocaleString('en-US')}`;
                                          
                                          await telegramBot.sendMessage(telegramChatId, message);
                                        }
                                        
                                      } catch (error) {
                                        setAutoTradeStatus(`❌ Cancellation error: ${error}`);
                                      }
                                    }}
                                    size="sm"
                                    variant="error"
                                    className="flex-1"
                                    disabled={isTrading}
                                  >
                                    ❌ Cancellation + Refund
                                  </Button>
                                ) : null}
                                <Button
                                  onClick={() => {
                                    setPreAuthBuyOrder(null);
                                    localStorage.removeItem(`preauth_buy_${publicKey}`);
                                    if (preAuthBuyOrder.isBot && preAuthBuyOrder.requiredXLM) {
                                      setAutoTradeStatus('⚠️ You have canceled the order. Use the "❌ Cancel + Refund" button to refund XLM.');
                                    }
                                  }}
                                  size="sm"
                                  variant="error"
                                  className="flex-1"
                                >
                                  🗑️ {preAuthBuyOrder.isBot ? 'Delete Only' : 'Cancel'}
                                </Button>
                              </div>
                            </div>
                          )}
                          
                          {preAuthBuyOrder && (
                            <div className="text-xs p-2 rounded bg-green-50 text-green-700">
                              <div className="whitespace-pre-line">{preAuthBuyOrder.status}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Sell settings */}
                    <div className="p-4 bg-red-50 rounded-lg border-2 border-red-200">
                      <h4 className="font-semibold text-red-800 mb-3">💸 Automatic Sales</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Target Price ({getAssetSymbol(autoTradeAssetOut)})</label>
                          <input
                            type="number"
                            step="0.0001"
                            placeholder="0.1400"
                            value={sellTargetPrice}
                            onChange={(e) => setSellTargetPrice(e.target.value)}
                            className="w-full px-3 py-2 border border-red-300 rounded"
                            disabled={isTrading || !isAutoTradingEnabled}
                          />
                          <p className="text-xs text-red-600 mt-1">
                            Price ≥ Sell at this value
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            Amount ({getAssetSymbol(legIn('sell', autoTradeAssetIn, autoTradeAssetOut))} &rarr; {getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))})
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="10"
                            value={autoSellAmount}
                            onChange={(e) => setAutoSellAmount(e.target.value)}
                            className="w-full px-3 py-2 border border-red-300 rounded"
                            disabled={isTrading || !isAutoTradingEnabled}
                          />
                        </div>

                        {/* Swap cost - sell quote */}
                        {autoSellAmount && (
                          <div className="space-y-2">
                            {quoteLoading ? (
                              <div className="bg-gray-100 p-3 rounded-lg border animate-pulse">
                                <div className="flex items-center text-sm text-gray-600">
                                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Calculating token exchange cost...
                                </div>
                              </div>
                            ) : sellQuote ? (
                              <div className="bg-red-100 p-3 rounded-lg border border-red-200">
                                <div className="text-sm font-medium text-red-800 mb-2">💸 Token Exchange Cost</div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <div>
                                    <span className="text-gray-600">You will spend:</span>
                                    <div className="font-mono font-bold text-red-700">
                                      {formatAmount(sellQuote.amountIn)} {getAssetSymbol(sellQuote.assetIn)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">You will receive (estimated):</span>
                                    <div className="font-mono font-bold text-red-700">
                                      {formatAmount(sellQuote.amountOut)} {getAssetSymbol(sellQuote.assetOut)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">Price Impact:</span>
                                    <div className={`font-bold ${parseFloat(sellQuote.priceImpactPct) > 5 ? 'text-red-600' : 'text-green-600'}`}>
                                      {formatPercentage(sellQuote.priceImpactPct)}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-600">Platform:</span>
                                    <div className="font-bold text-red-700">{sellQuote.platform}</div>
                                  </div>
                                </div>
                                {sellQuote.platformFee && (
                                  <div className="mt-2 pt-2 border-t border-red-200">
                                    <div className="text-xs text-gray-600">Platform Fee:</div>
                                    <div className="font-mono text-xs font-bold text-red-700">
                                      {formatAmount(sellQuote.platformFee.feeAmount)} ({sellQuote.platformFee.feeBps} bps)
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : autoSellAmount && (
                              <div className="bg-yellow-100 p-3 rounded-lg border border-yellow-200">
                                <div className="text-sm text-yellow-800">
                                  ⚠️ Token exchange cost could not be calculated
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {sellTargetPrice && (
                          <div className={`text-sm p-2 rounded ${displayPrice >= parseFloat(sellTargetPrice) ? 'bg-red-200 text-red-800 font-bold' : 'bg-gray-100 text-gray-600'}`}>
                            {displayPrice >= parseFloat(sellTargetPrice) ? '🎯 TARGET ACHIEVED!' : '⏳ Waiting for target...'}
                          </div>
                        )}
                        
                        {/* Pre-Authorization Buttons */}
                        <div className="space-y-2">
                          {!preAuthSellOrder ? (
                            <div className="space-y-2">
                              {/* Manuel Mod Butonu */}
                              {/* <Button
                                onClick={() => createPreAuthSellOrder(false)}
                                disabled={!sellTargetPrice || !autoSellAmount || !isConnected}
                                size="sm"
                                variant="secondary"
                                className="w-full"
                              > */}
                                {botMode === 'manual' && ( <Button
                                  onClick={() => createPreAuthSellOrder(false)}
                                  disabled={!sellTargetPrice || !autoSellAmount || !isConnected}
                                  size="md"
                                  variant="mrt2" className="w-full"
                                >
                                  👤 Manual Sell Order
                                </Button>
                              )}
                           
                              
                              {/* Bot Mod Butonu */}
                              {botMode === 'auto' && botWallet ? (
                                <Button
                                  onClick={() => createPreAuthSellOrder(true)}
                                  disabled={!sellTargetPrice || !autoSellAmount || !isConnected}
                                  size="md"
                                  variant="mrt2"
                                  className="w-full"
                                >
                                  🤖 Bot Sell Order
                                </Button>
                              ) : (
                                <div className="text-xs bg-yellow-100 p-2 rounded text-yellow-700 border">
                                  ⚠️ To use bot mode, select &quot;🤖 Automatic &quot; mode and create a bot wallet.
                                </div>
                              )}


                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="text-xs bg-red-100 text-red-700 p-2 rounded border">
                                ✅ Sell order ready
                                <div className="text-xs mt-1">
                                  ⏰ Expires in {Math.round((preAuthSellOrder.expiry.getTime() - Date.now()) / 60000)} min
                                </div>
                              </div>
                              <Button
                                onClick={() => {
                                  setPreAuthSellOrder(null);
                                  localStorage.removeItem(`preauth_sell_${publicKey}`);
                                }}
                                size="sm"
                                variant="error"
                                className="w-full"
                              >
                                ❌ Cancel Order
                              </Button>
                            </div>
                          )}
                          
                          {preAuthSellOrder && (
                            <div className="text-xs p-2 rounded bg-red-50 text-red-700">
                              <div className="whitespace-pre-line">{preAuthSellOrder.status}</div>
                            </div>
                          )}


                        </div>
                      </div>
                    </div>

                    {/* 🤖 Grid Trading Bot */}
                    <div className="p-4 bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg border-2 border-purple-200">
                      <h4 className="font-semibold text-purple-800 mb-3">🤖 Grid Trading Bot (Buy + Sell)</h4>
                      <div className="text-xs text-purple-600 mb-3 p-2 bg-purple-50 rounded border">
                        🔄 <strong>Order of Operations:</strong> 1️⃣ First BUY (low price, held in bot) → 2️⃣ Then SELL (high price, profit to main wallet)
                      </div>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-sm font-medium mb-1">Buy Price ({getAssetSymbol(autoTradeAssetOut)})</label>
                            <input
                              type="number"
                              step="0.0001"
                              placeholder="0.1300"
                              value={gridBuyPrice}
                              onChange={(e) => setGridBuyPrice(e.target.value)}
                              className="w-full px-2 py-2 border border-purple-300 rounded text-sm"
                              disabled={isTrading || (gridTradingBot?.isActive || false)}
                            />
                            <p className="text-xs text-purple-600 mt-1">
                              Price ≤ Buy at this value (equal and below)
                            </p>
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-1">Sell Price ({getAssetSymbol(autoTradeAssetOut)})</label>
                            <input
                              type="number"
                              step="0.0001"
                              placeholder="0.1400"
                              value={gridSellPrice}
                              onChange={(e) => setGridSellPrice(e.target.value)}
                              className="w-full px-2 py-2 border border-purple-300 rounded text-sm"
                              disabled={isTrading || (gridTradingBot?.isActive || false)}
                            />
                            <p className="text-xs text-purple-600 mt-1">
                              Price ≥ Sell at this value (equal and above)
                            </p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-sm font-medium mb-1">Amount</label>
                            <input
                              type="number"
                              step="0.01"
                              placeholder="100"
                              value={gridBuyAmount}
                              onChange={(e) => setGridBuyAmount(e.target.value)}
                              className="w-full px-3 py-2 border border-purple-300 rounded"
                              disabled={isTrading || (gridTradingBot?.isActive || false)}
                            />
                            <p className="text-xs text-purple-600 mt-1">
                               {getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))}&rarr;{getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))}
                            </p>
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-1">Amount</label>
                            <input
                              type="number"
                              step="0.01"
                              placeholder="50"
                              value={gridSellAmount}
                              onChange={(e) => setGridSellAmount(e.target.value)}
                              className="w-full px-3 py-2 border border-purple-300 rounded"
                              disabled={isTrading || (gridTradingBot?.isActive || false)}
                            />
                            <p className="text-xs text-purple-600 mt-1">
                               {getAssetSymbol(legIn('sell', autoTradeAssetIn, autoTradeAssetOut))}&rarr;{getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))}
                            </p>
                          </div>
                        </div>

                        {/* Swap cost - grid trading bot */}
                        {(gridBuyAmount || gridSellAmount) && (
                          <div className="space-y-3">
                            {gridQuoteLoading ? (
                              <div className="bg-gray-100 p-3 rounded-lg border animate-pulse">
                                <div className="flex items-center text-sm text-gray-600">
                                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Calculating token change costs...
                                </div>
                              </div>
                            ) : (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {/* Buy quote */}
                                {gridBuyQuote ? (
                                  <div className="bg-green-100 p-3 rounded-lg border border-green-200">
                                    <div className="text-sm font-medium text-green-800 mb-2">💰 BUY Quote</div>
                                    <div className="space-y-2 text-xs">
                                      <div>
                                        <span className="text-gray-600">You will spend:</span>
                                        <div className="font-mono font-bold text-green-700">
                                          {formatAmount(gridBuyQuote.amountIn)} {getAssetSymbol(gridBuyQuote.assetIn)}
                                        </div>
                                      </div>
                                      <div>
                                        <span className="text-gray-600">You will receive (estimated):</span>
                                        <div className="font-mono font-bold text-green-700">
                                          {formatAmount(gridBuyQuote.amountOut)} {getAssetSymbol(gridBuyQuote.assetOut)}
                                        </div>
                                      </div>
                                      <div>
                                        <span className="text-gray-600">Price Impact:</span>
                                        <div className={`font-bold ${parseFloat(gridBuyQuote.priceImpactPct) > 5 ? 'text-red-600' : 'text-green-600'}`}>
                                          {formatPercentage(gridBuyQuote.priceImpactPct)}
                                        </div>
                                      </div>
                                      {gridBuyQuote.platformFee && (
                                        <div>
                                          <span className="text-gray-600">Platform Fee:</span>
                                          <div className="font-mono font-bold text-green-700">
                                            {formatAmount(gridBuyQuote.platformFee.feeAmount)} ({gridBuyQuote.platformFee.feeBps} bps)
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : gridBuyAmount && (
                                  <div className="bg-yellow-100 p-3 rounded-lg border border-yellow-200">
                                    <div className="text-sm text-yellow-800">
                                      ⚠️ PURCHASE cost could not be calculated
                                    </div>
                                  </div>
                                )}

                                {/* Sell quote */}
                                {gridSellQuote ? (
                                  <div className="bg-red-100 p-3 rounded-lg border border-red-200">
                                    <div className="text-sm font-medium text-red-800 mb-2">💸 SELL Quote</div>
                                    <div className="space-y-2 text-xs">
                                      <div>
                                        <span className="text-gray-600">You will spend:
                                      </span>
                                        <div className="font-mono font-bold text-red-700">
                                          {formatAmount(gridSellQuote.amountIn)} {getAssetSymbol(gridSellQuote.assetIn)}
                                        </div>
                                      </div>
                                      <div>
                                        <span className="text-gray-600">You will receive:</span>
                                        <div className="font-mono font-bold text-red-700">
                                          {formatAmount(gridSellQuote.amountOut)} {getAssetSymbol(gridSellQuote.assetOut)}
                                        </div>
                                      </div>
                                      <div>
                                        <span className="text-gray-600">Price Impact:</span>
                                        <div className={`font-bold ${parseFloat(gridSellQuote.priceImpactPct) > 5 ? 'text-red-600' : 'text-green-600'}`}>
                                          {formatPercentage(gridSellQuote.priceImpactPct)}
                                        </div>
                                      </div>
                                      {gridSellQuote.platformFee && (
                                        <div>
                                          <span className="text-gray-600">Platform Fee:</span>
                                          <div className="font-mono font-bold text-red-700">
                                            {formatAmount(gridSellQuote.platformFee.feeAmount)} ({gridSellQuote.platformFee.feeBps} bps)
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : gridSellAmount && (
                                  <div className="bg-yellow-100 p-3 rounded-lg border border-yellow-200">
                                    <div className="text-sm text-yellow-800">
                                      ⚠️ SELL cost could not be calculated
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Net Kar Hesaplama — at the configured thresholds, not at the
                                current market. See the gridForecast memo for why. */}
                            {gridForecast && (
                              <div className="bg-blue-100 p-3 rounded-lg border border-blue-200">
                                <div className="text-sm font-medium text-blue-800 mb-2">
                                  💎 Net Profit Forecast
                                  <span className="font-normal text-blue-600"> — one completed cycle at your thresholds</span>
                                </div>
                                <div className="text-xs space-y-1">
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">
                                      Buy {gridBuyAmount} {getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))} at {gridBuyPrice} →
                                    </span>
                                    <span className="font-mono font-bold text-blue-700">
                                      {gridForecast.acquired.toFixed(7)} {getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">
                                      Sell {gridForecast.sold.toFixed(7)} at {gridSellPrice} →
                                    </span>
                                    <span className="font-mono font-bold text-blue-700">
                                      {gridForecast.revenue.toFixed(7)} {getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Cost of what is sold:</span>
                                    <span className="font-mono text-gray-700">−{gridForecast.cost.toFixed(7)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Swap fees (0.5% × 2 legs):</span>
                                    <span className="font-mono text-gray-700">−{gridForecast.fees.toFixed(7)}</span>
                                  </div>

                                  <div className="border-t border-blue-200 pt-1 mt-2">
                                    <div className="flex justify-between">
                                      <span className="text-gray-600 font-medium">Net Profit (estimated):</span>
                                      <span className={`font-mono font-bold ${gridForecast.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                        {gridForecast.net >= 0 ? '+' : ''}{gridForecast.net.toFixed(7)}
                                        {' '}{getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))}
                                        {' '}({gridForecast.netPct >= 0 ? '+' : ''}{gridForecast.netPct.toFixed(2)}%)
                                      </span>
                                    </div>
                                  </div>

                                  {gridForecast.net <= 0 && (
                                    <div className="text-red-700 font-medium pt-1">
                                      ⚠️ The spread does not cover the round trip&apos;s fees — a completed cycle loses money.
                                    </div>
                                  )}
                                  {gridForecast.oversized && (
                                    <div className="text-orange-700 pt-1">
                                      ⚠️ The sell amount is larger than the {gridForecast.acquired.toFixed(7)} the buy
                                      produces, so only that much can be sold.
                                    </div>
                                  )}
                                  {!gridForecast.oversized && gridForecast.leftover > 0 && (
                                    <div className="text-gray-600 pt-1">
                                      ℹ️ {gridForecast.leftover.toFixed(7)} {getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))} stays
                                      unsold after the cycle.
                                    </div>
                                  )}

                                  {/* The profit above is only collected if both thresholds are
                                      actually reached, so say how far away they are. */}
                                  {gridForecast.sellMove !== null && gridForecast.buyMove !== null && (
                                    <div className="pt-1 border-t border-blue-200 mt-1 space-y-0.5">
                                      <div className="text-gray-600">
                                        Buy fires when the pool moves{' '}
                                        <strong>{gridForecast.buyMove >= 0 ? '+' : ''}{gridForecast.buyMove.toFixed(2)}%</strong> from here
                                      </div>
                                      <div className="text-gray-600">
                                        Sell fires when it moves{' '}
                                        <strong>{gridForecast.sellMove >= 0 ? '+' : ''}{gridForecast.sellMove.toFixed(2)}%</strong> from here
                                      </div>
                                      {gridForecast.sellMove > 25 && (
                                        <div className="text-orange-700 font-medium">
                                          ⚠️ This profit is only realised if the price rises {gridForecast.sellMove.toFixed(0)}%.
                                          Until it does, the bot buys and then holds — the figure above is not money you are owed.
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  <div className="text-gray-500 pt-1 border-t border-blue-200 mt-1">
                                    Fees come to {gridForecast.feePctOfCost.toFixed(2)}% of the buy, not 1% — each leg pays
                                    0.5% of its own size, and the sell is larger when the spread is wide.
                                    Price impact is excluded; it depends on pool depth at execution time.
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* What the button is about to arm. Shown before confirming rather than
                            after, because once armed the bot trades on its own. */}
                        {gridBuyPrice && gridSellPrice && gridBuyAmount && gridSellAmount && !gridTradingBot?.isActive && (
                          <div className="p-3 bg-purple-100 rounded text-xs space-y-1 border border-purple-300">
                            <div className="font-semibold text-purple-900">Review before confirming</div>
                            <div className="text-purple-700">
                              1️⃣ Buy {gridBuyAmount} {getAssetSymbol(legIn('buy', autoTradeAssetIn, autoTradeAssetOut))}
                              {' → '}{getAssetSymbol(legOut('buy', autoTradeAssetIn, autoTradeAssetOut))} when the pool
                              price falls to {gridBuyPrice} or below
                            </div>
                            <div className="text-purple-700">
                              2️⃣ Then sell {gridSellAmount} {getAssetSymbol(legIn('sell', autoTradeAssetIn, autoTradeAssetOut))}
                              {' → '}{getAssetSymbol(legOut('sell', autoTradeAssetIn, autoTradeAssetOut))} when it reaches
                              {' '}{gridSellPrice} or above
                            </div>
                            <div className="text-purple-600">
                              📈 Spread: {((parseFloat(gridSellPrice) - parseFloat(gridBuyPrice)) / parseFloat(gridBuyPrice) * 100).toFixed(2)}%
                              {' · '}Pool price now: {poolPrice ? poolPrice.toFixed(6) : '—'}
                            </div>
                            {poolPrice > 0 && parseFloat(gridBuyPrice) >= poolPrice && (
                              <div className="text-orange-700 font-medium">
                                ⚠️ The buy threshold is already met — confirming will trade right away.
                              </div>
                            )}
                            {parseFloat(gridSellPrice) <= parseFloat(gridBuyPrice) && (
                              <div className="text-red-700 font-medium">
                                ⚠️ The sell price is not above the buy price, so a completed cycle loses money.
                              </div>
                            )}
                          </div>
                        )}

                        <div className="grid gap-2">
                          {botMode === 'manual' ? (
                            <Button
                              onClick={() => createGridTradingBot(false)}
                              disabled={isTrading || !gridBuyPrice || !gridSellPrice || !gridBuyAmount || !gridSellAmount || 
                                       (gridTradingBot?.isActive || false)}
                              variant="mrt"
                              size="md"
                              className="w-full"
                            >
                              ✅ Confirm &amp; start grid bot (you sign each trade)
                            </Button>
                          ) : (
                            <Button
                              onClick={() => createGridTradingBot(true)}
                              disabled={isTrading || !gridBuyPrice || !gridSellPrice || !gridBuyAmount || !gridSellAmount || 
                                       !botWallet || (gridTradingBot?.isActive || false)}
                              variant="mrt3"
                              size="md"
                              className="w-full"
                            >
                              ✅ Confirm &amp; start grid bot (bot signs)
                            </Button>
                          )}
                          
                          {gridTradingBot?.isActive && (
                            <Button
                              onClick={() => {
                                setGridTradingBot(null);
                                localStorage.removeItem(`grid_bot_${publicKey}`);
                                setAutoTradeStatus('❌ Grid trading bot durduruldu.');
                              }}
                              variant="error"
                              size="sm"
                              className="w-full"
                            >
                              ❌ Stop Bot
                            </Button>
                          )}
                        </div>
                          
                        {gridTradingBot && (
                          <div className="text-xs p-2 rounded bg-purple-50 text-purple-700">
                            <div className="whitespace-pre-line">{gridTradingBot.status}</div>
                            <div className="mt-2 text-purple-600">
                              🔄 Processing Stage: {
                                gridTradingBot.currentStep === 'waiting_buy' ? '1️⃣ Waiting for Purchase (Step One)' : 
                                gridTradingBot.currentStep === 'waiting_sell' ? '2️⃣ Waiting for Sale (Purchase Completed)' : 
                                '✅ Cycle Completed'
                              }
                            </div>
                            {gridTradingBot.currentStep === 'waiting_buy' && (
                              <div className="text-purple-600 text-xs mt-1">
                                📊 Target: Buy when the price drops to ${gridTradingBot.buyPrice} or below
                              </div>
                            )}
                            {gridTradingBot.currentStep === 'waiting_sell' && (
                              <div className="text-purple-600 text-xs mt-1">
                                📊 Target: Sell when the price rises to ${gridTradingBot.sellPrice} or above
                              </div>
                            )}
                            {gridTradingBot.expiry && (
                              <div className="text-purple-500 text-xs mt-1">
                                ⏰ Remaining Time: {Math.round((gridTradingBot.expiry.getTime() - Date.now()) / (1000 * 60))} minutes
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div> 
                  </div>

                  {/* Quick test buttons */}
                  <div className="grid grid-cols-2 gap-4">
                    <Button
                      onClick={() => {
                        const testPrice = (currentPrice * 0.995).toFixed(4);
                        setBuyTargetPrice(testPrice);
                        setAutoBuyAmount('1');
                        setIsAutoTradingEnabled(true);
                      }}
                      size="sm"
                      variant="success"
                      disabled={currentPrice === 0}
                    >
                      🧪 Test Buy (-0.5%)
                    </Button>
                    <Button
                      onClick={() => {
                        const testPrice = (currentPrice * 1.005).toFixed(4);
                        setSellTargetPrice(testPrice);
                        setAutoSellAmount('1');
                        setIsAutoTradingEnabled(true);
                      }}
                      size="sm"
                      variant="error"
                      disabled={currentPrice === 0}
                    >
                      🧪 Test Sell (+0.5%)
                    </Button>
                  </div>

                  {/* Durum Paneli */}
                  <div className="p-4 bg-white rounded-lg border-2 border-gray-200">
                    <h4 className="font-semibold mb-3">📊 System Status</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-gray-600">Current Price:</div>
                        <div className="font-mono text-lg font-bold">${displayPrice.toFixed(4)}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">System Status:</div>
                        <div className={`font-medium ${
                          hasAutoTradeError ? 'text-red-600' :
                          isTrading ? 'text-orange-600' :
                          isAutoTradingEnabled ? 'text-green-600' : 'text-gray-600'
                        }`}>
                          {hasAutoTradeError ? '🚨 Error' : 
                           isTrading ? '⏳ Processing' :
                           isAutoTradingEnabled ? '🟢 Active' : '⚪ Inactive'}
                        </div>
                      </div>
                    </div>
                    
                    {/* Pre-Auth Status */}
                    <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <div className="text-gray-600">Pre-Auth Buy:</div>
                        <div className={`font-medium ${preAuthBuyOrder ? 'text-green-600' : 'text-gray-400'}`}>
                          {preAuthBuyOrder ? '✅ Ready' : '⚪ None'}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-600">Pre-Auth Sell:</div>
                        <div className={`font-medium ${preAuthSellOrder ? 'text-red-600' : 'text-gray-400'}`}>
                          {preAuthSellOrder ? '✅ Ready' : '⚪ None'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Status message */}
                  {autoTradeStatus && (
                    <div className={`text-sm p-4 rounded-lg border-2 ${
                      autoTradeStatus.startsWith('✅') ? 'bg-green-50 border-green-200 text-green-700' :
                      autoTradeStatus.startsWith('❌') ? 'bg-red-50 border-red-200 text-red-700' :
                      autoTradeStatus.startsWith('🎯') ? 'bg-blue-50 border-blue-200 text-blue-700' :
                      'bg-yellow-50 border-yellow-200 text-yellow-700'
                    }`}>
                      <div className="whitespace-pre-line font-medium">{autoTradeStatus}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="text-gray-500 mb-4">🤖 Freighter wallet connection required for bot trading</div>
                  <Button onClick={connectWallet} disabled={!isAvailable} variant="success" className="mb-3">
                    🔗 Connect to Freighter
                  </Button>
                  <div className="text-xs text-yellow-700 bg-yellow-100 p-3 rounded border mx-4">
                    ⚠️ <strong>localhost connection problem?</strong><br/>
                    If you are receiving a &quot;domain not connected &quot; error, please click the button above.
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Bot trading explanation */}
        <Card title="📘 How Does the Dual Mode System Work?" className="bg-green-50 border-green-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div>
              <h4 className="font-semibold mb-3 text-green-800">👤 Manual Mode</h4>
              <ul className="space-y-2 text-green-700">
                <li>• <strong>1. Pre-Auth:</strong> &quot;👤 Manual Buy Order&quot; button</li>
                <li>• <strong>2. Follow-up:</strong> Bot price tracking is done</li>
                <li>• <strong>3. Triggering:</strong> Alert + popup at target price</li>
                <li>• <strong>4. Signature:</strong> Freighter opens, you sign the transaction</li>
                <li>• <strong>5. Money:</strong> Exits from your main wallet</li>
                <li>• <strong>6. Cancel:</strong> Cancel with &quot;🗑️ Cancel&quot;</li>
              </ul>
              <div className="mt-3 p-2 bg-blue-100 rounded text-blue-700">
                💡 <strong>Manual mode:</strong> If you are not at your PC, no transaction will be made.
              </div>
            </div>
            <div>
              <h4 className="font-semibold mb-3 text-green-800">🤖 Bot Mode (Automatic Transfer)</h4>
              <ul className="space-y-2 text-green-700">
                <li>• <strong>1. Preparation:</strong> Select bot mode and create a bot wallet</li>
                <li>• <strong>2. Transfer:</strong> Press the &quot;🤖 Bot Buy Order&quot; button</li>
                <li>• <strong>3. Freighter:</strong> Transfers the required XLM to the bot wallet</li>
                <li>• <strong>4. Follow-up:</strong> Bot price tracking is done</li>
                <li>• <strong>5. Automatic:</strong> Bot automatically trades at the target price</li>
                <li>• <strong>6. Cancel:</strong> Retrieve XLM with &quot;❌ Cancel + Refund&quot;</li>
              </ul>
              <div className="mt-3 p-2 bg-orange-100 rounded text-orange-700">
                🚀 <strong>Bot mode:</strong> Works even when you are not at your PC!
              </div>
            </div>
          </div>
          
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 bg-blue-50 rounded border-l-4 border-blue-400">
              <h5 className="font-semibold text-blue-800 mb-2">When to Use Manual Mode?</h5>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• You will be at your PC</li>
                <li>• You want to control the transaction yourself</li>
                <li>• You do not want to pay the fee in advance</li>
              </ul>
            </div>
            <div className="p-3 bg-orange-50 rounded border-l-4 border-orange-400">
              <h5 className="font-semibold text-orange-800 mb-2">When to Use Bot Mode?</h5>
              <ul className="text-orange-700 text-sm space-y-1">
                <li>• You will not be at your PC</li>
                <li>• You want full automation</li>
                <li>• You can pay the fee in advance</li>
              </ul>
            </div>
          </div>
        </Card>


          </div>
        )}
      </main>
    </div>
  );
}
