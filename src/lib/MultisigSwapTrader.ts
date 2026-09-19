// @/lib/MultisigSwapTrader.ts

import { 
  Keypair, 
  TransactionBuilder, 
  Networks, 
  Operation, 
  Horizon
} from "@stellar/stellar-sdk";

// Use Horizon.Server instead of importing StellarSdk default
const Server = Horizon.Server;
import { soroswapAPI } from '@/lib/api';
import { ASSET_OPTIONS } from '@/lib/constants';

// Interface definitions for type safety
interface Balance {
  asset_type: string;
  balance: string;
}

interface Signer {
  key: string;
  weight: number;
}

export interface MultisigTradeSignal {
  amount: number;
  assetIn: string;
  assetOut: string;
  direction: 'buy' | 'sell';
  confidence?: number;
  userPublicKey: string; // the user's public key
}

export interface MultisigSetupResult {
  success: boolean;
  tradingAddress: string;
  userPublicKey: string;
  botPublicKey: string;
  message: string;
  requiresSetup: boolean;
}

export interface MultisigTradeResult {
  success: boolean;
  transactionXDR?: string; // unsigned XDR - the user signs it
  partialXDR?: string; // partial XDR including the bot signature
  transactionId?: string;
  message: string;
  needsUserSignature?: boolean;
  error?: string;
}

export interface AccountStatus {
  initialized: boolean;
  address?: string;
  balance?: string;
  signers?: Array<{
    key: string;
    weight: number;
    type: string;
  }>;
  thresholds?: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  isMultisig?: boolean;
  botConnected?: boolean;
  error?: string;
}

export class MultisigSwapTrader {
  private botKeypair: Keypair;
  private server: Horizon.Server;
  
  // Configuration
  private readonly NETWORK = Networks.TESTNET;
  private readonly SERVER_URL = "https://horizon-testnet.stellar.org";
  private readonly DEFAULT_FEE = "100";
  private readonly TIMEOUT = 60;

  constructor(botSecretKey?: string) {
    if (botSecretKey) {
      try {
        this.botKeypair = Keypair.fromSecret(botSecretKey);
        console.log("🔑 Using stored bot secret key");
      } catch (error) {
        console.warn("⚠️ Invalid bot secret key provided, generating new one:", error);
        this.botKeypair = Keypair.random();
        console.log("🔑 Generated new bot secret key:", this.botKeypair.secret());
      }
    } else {
      this.botKeypair = Keypair.random();
      console.log("🔑 Generated bot secret key:", this.botKeypair.secret());
    }
    
    this.server = new Server(this.SERVER_URL);
    console.log("🤖 MultisigSwapTrader initialized with bot public key:", this.botKeypair.publicKey());
    
    // Fund the bot account automatically (in the background)
    this.ensureBotAccountFunded().catch(error => {
      console.error("❌ Bot account funding failed:", error);
    });
  }

  // 🆕 Fund the bot account with Friendbot
  private async ensureBotAccountFunded(): Promise<void> {
    try {
      console.log("🔍 Checking bot account funding status...");
      // First check whether the bot account exists
      await this.server.loadAccount(this.botKeypair.publicKey());
      console.log("✅ Bot account already exists and funded:", this.botKeypair.publicKey());
    } catch (error: unknown) {
      console.log("📋 Bot account check error:", error);
      
      // Hesap yoksa, Friendbot ile fund et
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found'))) {
        console.log("🚀 Bot account not found, funding with Friendbot...");
        console.log("🎯 Bot public key to fund:", this.botKeypair.publicKey());
        
        try {
          const friendbotUrl = `https://friendbot.stellar.org?addr=${this.botKeypair.publicKey()}`;
          console.log("📡 Friendbot URL:", friendbotUrl);
          
          const response = await fetch(friendbotUrl);
          console.log("📡 Friendbot response status:", response.status);
          
          if (response.ok) {
            const result = await response.text();
            console.log("✅ Bot account successfully funded by Friendbot");
            console.log("📝 Friendbot response:", result.substring(0, 100) + '...');
            
            // Verify the funding
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 saniye bekle
            try {
              const fundedAccount = await this.server.loadAccount(this.botKeypair.publicKey());
              const balance = fundedAccount.balances.find((b: Balance) => b.asset_type === 'native')?.balance || '0';
              console.log("✅ Bot account funding verified. Balance:", balance, "XLM");
            } catch (verifyError) {
              console.warn("⚠️ Could not verify bot account funding:", verifyError);
            }
          } else {
            const errorText = await response.text();
            console.error("❌ Friendbot funding failed:", response.status, response.statusText);
            console.error("❌ Friendbot error response:", errorText);
          }
        } catch (friendbotError: unknown) {
          console.error("❌ Friendbot request failed:", friendbotError);
        }
      } else {
        console.error("❌ Bot account check failed with unexpected error:", error);
      }
    }
  }

  // 🆕 Returns the bot public key
  public getBotPublicKey(): string {
    return this.botKeypair.publicKey();
  }

  // 🆕 Returns the bot secret key (for local storage only)
  public getBotSecretKey(): string {
    return this.botKeypair.secret();
  }

  // 🆕 Check the bot account status
  public async getBotAccountStatus(): Promise<AccountStatus> {
    try {
      const botAccount = await this.server.loadAccount(this.botKeypair.publicKey());
      
      return {
        initialized: true,
        address: this.botKeypair.publicKey(),
        balance: botAccount.balances.find((b: Balance) => b.asset_type === 'native')?.balance || '0',
        signers: botAccount.signers.map((s: Signer) => ({
          key: s.key,
          weight: s.weight,
          type: s.key === this.botKeypair.publicKey() ? 'ed25519_public_key' : 'unknown'
        })),
        thresholds: {
          low_threshold: botAccount.thresholds.low_threshold,
          med_threshold: botAccount.thresholds.med_threshold,
          high_threshold: botAccount.thresholds.high_threshold
        },
        isMultisig: botAccount.thresholds.med_threshold > 1,
        botConnected: true // the bot is always connected to its own account
      };
      
    } catch (error: unknown) {
      return {
        initialized: false,
        error: `Bot account check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }
  async checkMultisigSetup(userPublicKey: string): Promise<MultisigSetupResult> {
    try {
      console.log("🔍 Checking multisig setup for user:", userPublicKey);
      
      // Check the user account
      const userAccount = await this.server.loadAccount(userPublicKey);
      
      // Multisig check - is the bot added as a signer?
      const botSigner = userAccount.signers.find((s: Signer) => s.key === this.botKeypair.publicKey());
      const isMultisig = userAccount.thresholds.med_threshold > 1;
      
      if (botSigner && isMultisig) {
        return {
          success: true,
          tradingAddress: userPublicKey,
          userPublicKey: userPublicKey,
          botPublicKey: this.botKeypair.publicKey(),
          message: "✅ Multisig setup already configured!",
          requiresSetup: false
        };
      } else {
        return {
          success: false,
          tradingAddress: userPublicKey,
          userPublicKey: userPublicKey,
          botPublicKey: this.botKeypair.publicKey(),
          message: "⚠️ Multisig setup required. Please add bot as signer.",
          requiresSetup: true
        };
      }
      
    } catch (error: unknown) {
      return {
        success: false,
        tradingAddress: "",
        userPublicKey: userPublicKey,
        botPublicKey: this.botKeypair.publicKey(),
        message: `❌ Setup check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        requiresSetup: true
      };
    }
  }

  // 🆕 Build the multisig setup transaction (bot-signed, awaiting the user signature)
  async createMultisigSetupTransaction(userPublicKey: string): Promise<string> {
    try {
      console.log("🔧 Creating multisig setup transaction for:", userPublicKey);
      
      const userAccount = await this.server.loadAccount(userPublicKey);
      
      // Build the multisig setup transaction
      const transaction = new TransactionBuilder(userAccount, {
        fee: this.DEFAULT_FEE,
        networkPassphrase: this.NETWORK
      })
        .addOperation(Operation.setOptions({
          signer: {
            ed25519PublicKey: this.botKeypair.publicKey(),
            weight: 1
          }
        }))
        
        .addOperation(Operation.setOptions({
          lowThreshold: 2,  // 2-of-2 multisig
          medThreshold: 2,
          highThreshold: 2
        }))
        .setTimeout(this.TIMEOUT)
        .build();
      
      // Return unsigned XDR - user must sign first since it's their account
      console.log("📝 Setup transaction created (unsigned) - user must sign first");
      
      return transaction.toXDR();
      
    } catch (error: unknown) {
      throw new Error(`Multisig setup transaction creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // 🆕 Build a trade transaction via SwapAPI (multisig compatible)
  async createSwapTrade(signal: MultisigTradeSignal): Promise<MultisigTradeResult> {
    try {
      console.log("🔄 Creating swap trade with multisig:", signal);
      
      // Multisig setup check
      const setupCheck = await this.checkMultisigSetup(signal.userPublicKey);
      if (setupCheck.requiresSetup) {
        return {
          success: false,
          message: "❌ Multisig setup required first",
          error: setupCheck.message
        };
      }

      // Asset bilgilerini al
      const assetInInfo = ASSET_OPTIONS.find(a => a.value === signal.assetIn);
      const assetOutInfo = ASSET_OPTIONS.find(a => a.value === signal.assetOut);
      
      if (!assetInInfo || !assetOutInfo) {
        throw new Error('Invalid asset selection');
      }

      // Prepare the amount for SwapAPI (7 decimals)
      const tradeAmountScaled = (signal.amount * Math.pow(10, 7)).toString();

      // 1. SwapAPI Quote al
      const quoteRequest = {
        assetIn: signal.assetIn,
        assetOut: signal.assetOut,
        amount: tradeAmountScaled,
        tradeType: 'EXACT_IN' as const,
        protocols: ['soroswap'],
        slippageTolerance: 500, // %5 slippage
        feeBps: 50,
        parts: 50,
        maxHops: 1,
      };

      console.log('🔍 Getting quote from SwapAPI:', quoteRequest);
      const quote = await soroswapAPI.getQuote(quoteRequest);
      console.log('✅ Quote received:', quote);

      // 2. SwapAPI ile transaction build et
      const buildRequest = {
        quote: quote,
        referralId: "GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO",
        sponsor: "GDISPX62G6EGBZX3I2VMB4J3O3CPFHHRAJ4QZNOYVXYVHJ6BVRL2A3Y3",
        from: signal.userPublicKey, // the user's public key
        slippageTolerancePercent: true,
      };

      console.log('🔨 Building transaction with SwapAPI:', buildRequest);
      const buildResponse = await soroswapAPI.buildTransaction(buildRequest);
      console.log('✅ Transaction built:', buildResponse);

      // 3. Parse the transaction
      const transaction = TransactionBuilder.fromXDR(buildResponse.xdr, this.NETWORK);

      // 4. Bot otomatik imzalar (1/2)
      transaction.sign(this.botKeypair);
      console.log("✅ Bot signed the transaction (1/2)");

      // 5. Return the partial XDR (the user adds the second signature)
      const partialXDR = transaction.toXDR();

      return {
        success: true,
        transactionXDR: buildResponse.xdr, // original XDR (unsigned)
        partialXDR: partialXDR, // includes the bot signature
        message: `✅ Swap transaction ready for user signature
        Trade: ${signal.amount} ${assetInInfo.symbol} → ${assetOutInfo.symbol}
        Bot signature: ✅ (1/2)
        User signature: ⏳ Pending`,
        needsUserSignature: true
      };

    } catch (error: unknown) {
      console.error('❌ Swap trade creation failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `❌ Swap trade failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // 🆕 Submit once the user signature is in place
  async submitUserSignedTransaction(userSignedXDR: string): Promise<MultisigTradeResult> {
    try {
      console.log("📤 Submitting user signed transaction...");
      
      // SwapAPI ile transaction submit et
      const sendRequest = { xdr: userSignedXDR };
      const sendResponse = await soroswapAPI.sendTransaction(sendRequest);
      
      console.log('✅ Transaction submitted successfully:', sendResponse);
      
      return {
        success: true,
        transactionId: sendResponse.hash,
        message: `✅ Multisig swap completed successfully!
        Transaction Hash: ${sendResponse.hash}
        Both signatures verified: ✅
        Trade executed via SwapAPI: ✅`
      };

    } catch (error: unknown) {
      console.error('❌ Transaction submission failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `❌ Transaction submission failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // 🆕 AI komut parser (basit versiyon)
  parseAICommand(message: string, currentPrice: number, userPublicKey: string): MultisigTradeSignal | null {
    const lowerMessage = message.toLowerCase();
    
    // Miktar tespit et
    const amountMatch = message.match(/(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 50;
    
    if (lowerMessage.includes('al') || lowerMessage.includes('buy')) {
      return {
        amount: amount,
        assetIn: ASSET_OPTIONS[0].value, // XLM
        assetOut: ASSET_OPTIONS[2].value, // USDC
        direction: 'buy',
        confidence: 0.8,
        userPublicKey: userPublicKey
      };
    } else if (lowerMessage.includes('sat') || lowerMessage.includes('sell')) {
      return {
        amount: amount,
        assetIn: ASSET_OPTIONS[2].value, // USDC
        assetOut: ASSET_OPTIONS[0].value, // XLM
        direction: 'sell',
        confidence: 0.8,
        userPublicKey: userPublicKey
      };
    }
    
    return null;
  }

  // 🆕 Account durumu sorgula
  async getAccountStatus(userPublicKey: string): Promise<AccountStatus> {
    try {
      const account = await this.server.loadAccount(userPublicKey);
      const nativeBalance = account.balances.find((b: Balance) => b.asset_type === 'native');
      
      return {
        initialized: true,
        address: userPublicKey,
        balance: nativeBalance?.balance || '0',
        signers: account.signers.map((s: Signer) => ({
          key: s.key,
          weight: s.weight,
          type: s.key === userPublicKey ? 'master' : 
               s.key === this.botKeypair.publicKey() ? 'bot' : 'other'
        })),
        thresholds: account.thresholds,
        isMultisig: account.thresholds.med_threshold > 1,
        botConnected: account.signers.some((s: Signer) => s.key === this.botKeypair.publicKey())
      };
    } catch (error: unknown) {
      return {
        initialized: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export default MultisigSwapTrader;