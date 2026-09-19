// // src/app/api/trading/route.ts
// import { NextRequest, NextResponse } from 'next/server';

// const SOROSWAP_API_BASE = 'https://api.soroswap.finance';
// const API_KEY = process.env.SOROSWAP_API_KEY || 'demo-key';

// export async function POST(request: NextRequest) {
//   try {
//     const body = await request.json();
//     const { action, ...params } = body;

//     switch (action) {
//       case 'getPrice':
//         return await handleGetPrice(params);
//       case 'getQuote':
//         return await handleGetQuote(params);
//       case 'buildTransaction':
//         return await handleBuildTransaction(params);
//       case 'sendTransaction':
//         return await handleSendTransaction(params);
//       default:
//         return NextResponse.json(
//           { error: 'Invalid action' },
//           { status: 400 }
//         );
//     }
//   } catch (error) {
//     console.error('Trading API error:', error);
//     return NextResponse.json(
//       { error: 'Internal server error' },
//       { status: 500 }
//     );
//   }
// }

// export async function GET(request: NextRequest) {
//   const { searchParams } = new URL(request.url);
//   const action = searchParams.get('action');

//   try {
//     switch (action) {
//       case 'health':
//         return NextResponse.json({ status: 'OK', timestamp: Date.now() });
//       case 'protocols':
//         return await handleGetProtocols(searchParams.get('network') || 'mainnet');
//       default:
//         return NextResponse.json(
//           { error: 'Invalid GET action' },
//           { status: 400 }
//         );
//     }
//   } catch (error) {
//     console.error('Trading GET error:', error);
//     return NextResponse.json(
//       { error: 'Internal server error' },
//       { status: 500 }
//     );
//   }
// }

// async function handleGetPrice(params: { assets: string; network?: string }) {
//   try {
//     const { assets, network = 'mainnet' } = params;
    
//     const response = await fetch(
//       `${SOROSWAP_API_BASE}/price?network=${network}&asset=${assets}`,
//       {
//         headers: {
//           'Authorization': `Bearer ${API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Price API error: ${response.status} - ${errorText}`);
//     }

//     const data = await response.json();
//     return NextResponse.json(data);
//   } catch (error) {
//     console.error('Get price error:', error);
//     return NextResponse.json(
//       { error: `Failed to get price: ${error}` },
//       { status: 500 }
//     );
//   }
// }

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// async function handleGetQuote(params: any) {
//   try {
//     const { network = 'mainnet', ...quoteParams } = params;
    
//     const requestBody = {
//       assetIn: quoteParams.assetIn,
//       assetOut: quoteParams.assetOut,
//       amount: quoteParams.amount,
//       tradeType: quoteParams.tradeType || 'EXACT_IN',
//       protocols: quoteParams.protocols || ['soroswap', 'phoenix', 'aqua', 'sdex'],
//       slippageTolerance: quoteParams.slippageTolerance || 50,
//       gaslessTrustline: quoteParams.gaslessTrustline || false,
//       feeBps: quoteParams.feeBps || 50
//     };
    
//     const response = await fetch(
//       `${SOROSWAP_API_BASE}/quote?network=${network}`,
//       {
//         method: 'POST',
//         headers: {
//           'Authorization': `Bearer ${API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify(requestBody),
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Quote API error: ${response.status} - ${errorText}`);
//     }

//     const data = await response.json();
//     return NextResponse.json(data);
//   } catch (error) {
//     console.error('Get quote error:', error);
//     return NextResponse.json(
//       { error: `Failed to get quote: ${error}` },
//       { status: 500 }
//     );
//   }
// }

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// async function handleBuildTransaction(params: any) {
//   try {
//     const { network = 'mainnet', ...buildParams } = params;
    
//     const response = await fetch(
//       `${SOROSWAP_API_BASE}/quote/build?network=${network}`,
//       {
//         method: 'POST',
//         headers: {
//           'Authorization': `Bearer ${API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify(buildParams),
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Build API error: ${response.status} - ${errorText}`);
//     }

//     const data = await response.json();
//     return NextResponse.json(data);
//   } catch (error) {
//     console.error('Build transaction error:', error);
//     return NextResponse.json(
//       { error: `Failed to build transaction: ${error}` },
//       { status: 500 }
//     );
//   }
// }

// async function handleSendTransaction(params: { xdr: string; network?: string }) {
//   try {
//     const { xdr, network = 'mainnet' } = params;
    
//     const response = await fetch(
//       `${SOROSWAP_API_BASE}/send?network=${network}`,
//       {
//         method: 'POST',
//         headers: {
//           'Authorization': `Bearer ${API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ xdr }),
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Send API error: ${response.status} - ${errorText}`);
//     }

//     const data = await response.json();
//     return NextResponse.json(data);
//   } catch (error) {
//     console.error('Send transaction error:', error);
//     return NextResponse.json(
//       { error: `Failed to send transaction: ${error}` },
//       { status: 500 }
//     );
//   }
// }

// async function handleGetProtocols(network: string) {
//   try {
//     const response = await fetch(
//       `${SOROSWAP_API_BASE}/protocols?network=${network}`,
//       {
//         headers: {
//           'Authorization': `Bearer ${API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Protocols API error: ${response.status} - ${errorText}`);
//     }

//     const data = await response.json();
//     return NextResponse.json(data);
//   } catch (error) {
//     console.error('Get protocols error:', error);
//     return NextResponse.json(
//       { error: `Failed to get protocols: ${error}` },
//       { status: 500 }
//     );
//   }
// }

// src/app/api/trading/route.ts
import { NextRequest, NextResponse } from 'next/server';

const SOROSWAP_API_BASE = 'https://soroswap-api-staging-436722401508.us-central1.run.app';
const API_KEY = process.env.SOROSWAP_API_KEY || 'demo-key';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      case 'getPrice':
        return await handleGetPrice(params);
      case 'getQuote':
        return await handleGetQuote(params);
      case 'buildTransaction':
        return await handleBuildTransaction(params);
      case 'sendTransaction':
        return await handleSendTransaction(params);
      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Trading API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    switch (action) {
      case 'health':
        return NextResponse.json({ status: 'OK', timestamp: Date.now() });
      case 'protocols':
        return await handleGetProtocols(searchParams.get('network') || 'testnet');
      default:
        return NextResponse.json(
          { error: 'Invalid GET action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Trading GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

async function handleGetPrice(params: { assets: string; network?: string }) {
  try {
    const { assets, network = 'mainnet' } = params;
    
    const response = await fetch(`${SOROSWAP_API_BASE}/price?network=${network}&asset=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75,CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Price API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Get price error:', error);
    return NextResponse.json(
      { error: `Failed to get price: ${error}` },
      { status: 500 }
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleGetQuote(params: any) {
  try {
    const { network = 'testnet', ...quoteParams } = params;
    
    const requestBody = {
      assetIn: quoteParams.assetIn,
      assetOut: quoteParams.assetOut,
      amount: quoteParams.amount,
      tradeType: quoteParams.tradeType || 'EXACT_IN',
      protocols: quoteParams.protocols || ['soroswap', 'aqua'],
      slippageTolerance: quoteParams.slippageTolerance || 50,
      gaslessTrustline: quoteParams.gaslessTrustline || false,
      feeBps: quoteParams.feeBps || 50
    };
    
    const response = await fetch(
      `${SOROSWAP_API_BASE}/quote?network=${network}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Quote API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Get quote error:', error);
    return NextResponse.json(
      { error: `Failed to get quote: ${error}` },
      { status: 500 }
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleBuildTransaction(params: any) {
  try {
    const { network = 'testnet', ...buildParams } = params;
    
    const response = await fetch(
      `${SOROSWAP_API_BASE}/quote/build?network=${network}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildParams),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Build API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Build transaction error:', error);
    return NextResponse.json(
      { error: `Failed to build transaction: ${error}` },
      { status: 500 }
    );
  }
}

async function handleSendTransaction(params: { xdr: string; network?: string }) {
  try {
    const { xdr, network = 'testnet' } = params;
    
    const response = await fetch(
      `${SOROSWAP_API_BASE}/send?network=${network}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ xdr }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Send API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Send transaction error:', error);
    return NextResponse.json(
      { error: `Failed to send transaction: ${error}` },
      { status: 500 }
    );
  }
}

async function handleGetProtocols(network: string) {
  try {
    const response = await fetch(
      `${SOROSWAP_API_BASE}/protocols?network=${network}`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Protocols API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Get protocols error:', error);
    return NextResponse.json(
      { error: `Failed to get protocols: ${error}` },
      { status: 500 }
    );
  }
}