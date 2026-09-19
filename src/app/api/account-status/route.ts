import { NextRequest, NextResponse } from 'next/server';
import * as StellarSdk from '@stellar/stellar-sdk';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const publicKey = searchParams.get('publicKey');
    
    if (!publicKey) {
      return NextResponse.json(
        { success: false, error: 'Public key is required' },
        { status: 400 }
      );
    }

    console.log('🔍 Checking account status for:', publicKey);

    // Stellar Horizon server
    const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');

    try {
      const account = await server.loadAccount(publicKey);
      
      const accountInfo = {
        success: true,
        exists: true,
        publicKey: account.accountId(),
        balances: account.balances,
        signers: account.signers,
        thresholds: account.thresholds,
        sequenceNumber: account.sequenceNumber()
      };
      
      console.log('✅ Account found:', accountInfo);
      return NextResponse.json(accountInfo);
      
    } catch (accountError: unknown) {
      console.log('❌ Account not found or not funded:', accountError);
      
      if (accountError && typeof accountError === 'object' && 'response' in accountError) {
        const stellarError = accountError as { response?: { status?: number } };
        if (stellarError.response?.status === 404) {
          return NextResponse.json({
            success: true,
            exists: false,
            publicKey,
            message: 'Account not found - needs to be funded',
            fundUrl: `https://friendbot.stellar.org?addr=${publicKey}`
          });
        }
      }
      
      throw accountError;
    }

  } catch (error: unknown) {
    console.error('❌ Account check failed:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Account check failed'
      },
      { status: 500 }
    );
  }
}
