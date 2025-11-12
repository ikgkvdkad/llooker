const { Pinecone } = require('@pinecone-database/pinecone');

const PINECONE_INDEX_NAME = 'llooker2';

function getPineconeClient() {
  const apiKey = process.env.PINECONEKEY || process.env.PINECONE_API_KEY;
  
  if (!apiKey) {
    return null;
  }

  try {
    return new Pinecone({ apiKey });
  } catch (error) {
    console.error('Failed to initialize Pinecone client:', error);
    return null;
  }
}

async function generateEmbedding(text, apiKey) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text for embedding generation');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float'
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI Embedding API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const pc = getPineconeClient();
  
  if (!pc) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Pinecone not configured. Set PINECONEKEY environment variable.'
      })
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
  
  if (!openaiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'OpenAI API key not configured.'
      })
    };
  }

  let requestPayload;
  
  try {
    requestPayload = JSON.parse(event.body);
  } catch (parseError) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { query, topK = 10, filter = {} } = requestPayload;

  if (!query || typeof query !== 'string') {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Query text is required' })
    };
  }

  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query, openaiKey);

    // Get the index
    const index = pc.index(PINECONE_INDEX_NAME);

    // Build filter object for Pinecone
    const pineconeFilter = {};
    
    if (filter.role) {
      pineconeFilter.role = filter.role;
    }
    
    if (filter.hasLocation !== undefined) {
      pineconeFilter.hasLocation = filter.hasLocation;
    }

    // Query Pinecone
    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK: Math.min(topK, 100), // Max 100 results
      includeMetadata: true,
      filter: Object.keys(pineconeFilter).length > 0 ? pineconeFilter : undefined
    });

    // Format results
    const results = queryResponse.matches.map(match => ({
      id: match.id,
      score: match.score,
      dbId: match.metadata?.dbId,
      description: match.metadata?.description,
      role: match.metadata?.role,
      capturedAt: match.metadata?.capturedAt,
      latitude: match.metadata?.latitude,
      longitude: match.metadata?.longitude,
      hasLocation: match.metadata?.hasLocation
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        results,
        count: results.length
      })
    };

  } catch (error) {
    console.error('Search error:', {
      message: error?.message,
      stack: error?.stack
    });

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Search failed',
        details: error?.message || 'Unknown error'
      })
    };
  }
};

