import { Redirect } from 'expo-router';

export default function PortfolioRedirect() {
  return <Redirect href={{ pathname: '/', params: { page: 'portfolio' } }} />;
}
