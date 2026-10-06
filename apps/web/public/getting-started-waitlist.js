import { createGettingStarted } from './getting-started.js';
const mount = document.getElementById('waitlist-getting-ready');
if (mount) mount.replaceWith(createGettingStarted({ storageKey: 'mosshatch:waitlist-preparation', description: 'A little preparation while you wait. These checkmarks are your reminders; confirmation and invitations arrive by email.', steps: [
  { id: 'email', title: 'Check your confirmation email', description: 'Use the email link if confirmation is requested. This checkmark does not confirm your signup.', manual: true },
  { id: 'name', title: 'Keep a shortlist of names', description: 'Jot down a favorite and a backup. A waitlist signup does not reserve or register a domain.', manual: true },
  { id: 'expectations', title: 'Know what happens next', description: 'Read how domains, creatures and invitations work before your invite arrives.', manual: true, href: '/how-it-works', actionLabel: 'See how Mosshatch works' }
]}));
