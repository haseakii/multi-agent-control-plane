import type { PolicyRule } from './types.js';

export function createDefaultPolicyRules(): PolicyRule[] {
  return [
    {
      id: 'workspace-read',
      actionPattern: 'workspace.read',
      effect: 'allow',
      description: 'Mediated workspace reads are allowed by default.',
    },
    {
      id: 'workspace-write',
      actionPattern: 'workspace.write',
      effect: 'ask',
      description: 'Writable workspace access requires approval.',
    },
    {
      id: 'workspace-outside',
      actionPattern: 'workspace.outside',
      effect: 'deny',
      description: 'Access outside the assigned workspace is denied when mediated.',
    },
    {
      id: 'shell',
      actionPattern: 'shell.*',
      effect: 'ask',
      description: 'Mediated shell operations require approval.',
    },
    {
      id: 'network',
      actionPattern: 'network.*',
      effect: 'ask',
      description: 'Mediated network operations require approval.',
    },
    {
      id: 'git-force-push',
      actionPattern: 'git.force-push',
      effect: 'deny',
      description: 'Force-push is denied.',
    },
    {
      id: 'git',
      actionPattern: 'git.*',
      effect: 'ask',
      description: 'Mediated Git mutation requires approval.',
    },
    {
      id: 'packages-install',
      actionPattern: 'packages.install',
      effect: 'ask',
      description: 'Package installation requires approval.',
    },
  ];
}
