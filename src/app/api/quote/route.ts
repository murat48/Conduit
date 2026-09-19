import { NextRequest, NextResponse } from 'next/server';
import { QuoteRequest } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body: QuoteRequest = await request.json();
    
    // API call to Soroswap
    const response = await fetch(`${process.env.SOROSWAP_API_HOST}/quote?network=testnet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SOROSWAP_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Quote API Error:', error);
    return NextResponse.json(
      { error: 'Failed to get quote' },
      { status: 500 }
    );
  }
}
