// Test network connection endpoint
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    console.log('🧪 Testing network connections...');
    
    const results = {
      timestamp: new Date().toISOString(),
      tests: {
        coinGecko: { status: 'unknown', error: null as string | null },
        soroswap: { status: 'unknown', error: null as string | null },
        stellar: { status: 'unknown', error: null as string | null }
      }
    };

    // Test 1: CoinGecko API
    try {
      console.log('🌐 Testing CoinGecko API...');
      const coinGeckoResponse = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
        { 
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000)
        }
      );
      
      if (coinGeckoResponse.ok) {
        const data = await coinGeckoResponse.json();
        results.tests.coinGecko.status = data.stellar?.usd ? 'success' : 'invalid_data';
      } else {
        results.tests.coinGecko.status = 'error';
        results.tests.coinGecko.error = `${coinGeckoResponse.status} ${coinGeckoResponse.statusText}`;
      }
    } catch (error) {
      results.tests.coinGecko.status = 'error';
      results.tests.coinGecko.error = error instanceof Error ? error.message : 'Unknown error';
    }

    // Test 2: Soroswap API  
    try {
      console.log('🔗 Testing Soroswap API...');
      const soroswapResponse = await fetch(
        'https://api.soroswap.finance/health',
        { 
          method: 'GET',
          signal: AbortSignal.timeout(10000)
        }
      );
      
      results.tests.soroswap.status = soroswapResponse.ok ? 'success' : 'error';
      if (!soroswapResponse.ok) {
        results.tests.soroswap.error = `${soroswapResponse.status} ${soroswapResponse.statusText}`;
      }
    } catch (error) {
      results.tests.soroswap.status = 'error';
      results.tests.soroswap.error = error instanceof Error ? error.message : 'Unknown error';
    }

    // Test 3: Stellar Horizon
    try {
      console.log('⭐ Testing Stellar Horizon...');
      const stellarResponse = await fetch(
        'https://horizon-testnet.stellar.org/',
        { 
          method: 'GET',
          signal: AbortSignal.timeout(10000)
        }
      );
      
      results.tests.stellar.status = stellarResponse.ok ? 'success' : 'error';
      if (!stellarResponse.ok) {
        results.tests.stellar.error = `${stellarResponse.status} ${stellarResponse.statusText}`;
      }
    } catch (error) {
      results.tests.stellar.status = 'error';
      results.tests.stellar.error = error instanceof Error ? error.message : 'Unknown error';
    }

    console.log('🧪 Network test results:', results);

    return NextResponse.json({
      success: true,
      message: 'Network connectivity test completed',
      results
    });

  } catch (error) {
    console.error('❌ Network test failed:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Network test failed'
    }, { status: 500 });
  }
}
