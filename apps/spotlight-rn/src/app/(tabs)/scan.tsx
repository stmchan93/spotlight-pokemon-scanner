import { Redirect } from 'expo-router';

export default function ScanRedirect() {
  return <Redirect href={{ pathname: '/', params: { page: 'scanner' } }} />;
}
