import { withLambda } from '@netlify/aws-lambda-compat';

const handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      supabase_url: process.env.SUPABASE_URL,
      supabase_anon: process.env.SUPABASE_ANON_KEY
    })
  };
};
export default withLambda(handler);
