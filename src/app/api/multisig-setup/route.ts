import { NextRequest, NextResponse } from 'next/server';
import MultisigSwapTrader from '@/lib/MultisigSwapTrader';

// Bot secret key (can come from an environment variable)
const BOT_SECRET_KEY = process.env.MULTISIG_BOT_SECRET_KEY;

export async function POST(request: NextRequest) {
  try {
    const { userPublicKey, action } = await request.json();

    if (!userPublicKey) {
      return NextResponse.json({ 
        success: false, 
        error: 'User public key required' 
      }, { status: 400 });
    }

    // Create the multisig trader instance
    const trader = new MultisigSwapTrader(BOT_SECRET_KEY);

    switch (action) {
      case 'check':
        // Multisig setup durumunu kontrol et
        const setupStatus = await trader.checkMultisigSetup(userPublicKey);
        const accountStatus = await trader.getAccountStatus(userPublicKey);
        
        return NextResponse.json({
          success: true,
          setupStatus,
          accountStatus,
          botPublicKey: trader.getBotPublicKey()
        });

      case 'create-setup':
        // Build the multisig setup transaction
        const setupXDR = await trader.createMultisigSetupTransaction(userPublicKey);
        
        return NextResponse.json({
          success: true,
          setupXDR,
          message: 'Multisig setup transaction created. Please sign and submit.'
        });

      case 'bot-status':
        // Bot hesap durumunu kontrol et
        const botStatus = await trader.getBotAccountStatus();
        
        return NextResponse.json({
          success: true,
          botStatus,
          botPublicKey: trader.getBotPublicKey()
        });

      default:
        return NextResponse.json({ 
          success: false, 
          error: 'Invalid action' 
        }, { status: 400 });
    }

  } catch (error) {
    console.error('❌ Multisig setup API error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userPublicKey = searchParams.get('userPublicKey');

    if (!userPublicKey) {
      return NextResponse.json({ 
        success: false, 
        error: 'User public key required' 
      }, { status: 400 });
    }

    // Sadece durumu kontrol et
    const trader = new MultisigSwapTrader(BOT_SECRET_KEY);
    const setupStatus = await trader.checkMultisigSetup(userPublicKey);
    const accountStatus = await trader.getAccountStatus(userPublicKey);
    const botStatus = await trader.getBotAccountStatus();

    return NextResponse.json({
      success: true,
      setupStatus,
      accountStatus,
      botStatus,
      botPublicKey: trader.getBotPublicKey()
    });

  } catch (error) {
    console.error('❌ Multisig status check error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 });
  }
}
