import { NextRequest, NextResponse } from 'next/server';
import { BuildRequest } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body: BuildRequest = await request.json();
    
    console.log('🔨 Build API Request:', JSON.stringify(body, null, 2));
    
    // API call to Soroswap build endpoint
    const response = await fetch(`${process.env.SOROSWAP_API_HOST}/quote/build?network=testnet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SOROSWAP_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Soroswap Build API Error:', errorText);
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Build API Success:', JSON.stringify(data, null, 2));
    return NextResponse.json(data);
  } catch (error) {
    console.error('Build API Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build transaction' },
      { status: 500 }
    );
  }
}
