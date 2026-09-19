import { redirect } from 'next/navigation';

// This page moved to the root ("/") so it opens by default.
export default function AnchorRedirect() {
  redirect('/');
}
