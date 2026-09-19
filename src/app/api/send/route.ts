import { NextRequest, NextResponse } from 'next/server';
import { SendRequest } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body: SendRequest = await request.json();
    
    console.log('📤 Send API Request:', JSON.stringify(body, null, 2));
    
    // API call to Soroswap send endpoint
    const response = await fetch(`${process.env.SOROSWAP_API_HOST}/send?network=testnet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SOROSWAP_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Soroswap Send API Error:', errorText);
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Send API Success:', JSON.stringify(data, null, 2));
    return NextResponse.json(data);
  } catch (error) {
    console.error('Send API Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to send transaction' },
      { status: 500 }
    );
  }
}
