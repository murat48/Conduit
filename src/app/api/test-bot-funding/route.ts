import { NextResponse } from 'next/server';
import MultisigSwapTrader from '@/lib/MultisigSwapTrader';

export async function POST() {
  console.log('🚀 API /test-bot-funding called');
  
  try {
    console.log('🤖 Creating new MultisigSwapTrader instance...');
    const trader = new MultisigSwapTrader();
    
    // Bot public key'ini al
    const botPublicKey = trader.getBotPublicKey();
    console.log('🤖 Bot public key:', botPublicKey);
    
    // Bot account status'unu kontrol et
    console.log('📊 Checking bot account status...');
    const botStatus = await trader.getBotAccountStatus();
    console.log('📊 Bot account status:', botStatus);
    
    return NextResponse.json({
      success: true,
      botPublicKey,
      botStatus,
      message: 'Bot funding test completed'
    });
    
  } catch (error: unknown) {
    console.error('❌ Bot funding test failed:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
