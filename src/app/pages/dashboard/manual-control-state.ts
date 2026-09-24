export interface ManualControlEntityState {
  kind: 'valve' | 'pump';
  state: 'on' | 'off' | 'fault' | 'unavailable' | 'unknown';
  online: boolean;
  held: boolean;
  routeControlled: boolean;
  phase: 'pending' | 'confirmed' | 'refused' | 'expired' | null;
}

export interface ManualControlPresentation {
  canActuate: boolean;
  action: 'Sending…' | 'Release' | 'Held' | 'Offline' | 'Read only' | 'Fault' | 'In use' | 'Locked' | 'Retry' | 'Hold';
  reported: 'Offline' | 'Releasing' | 'Starting' | 'Refused' | 'Unconfirmed' | 'Fault' | 'Open' | 'Closed' | 'Running' | 'Stopped' | 'Unknown';
}

/** Pure state projection for the inline manual-control card. Keeping this out of
 * the component makes the safety/ownership combinations exhaustive and testable. */
export function resolveManualControl(
  entity: ManualControlEntityState,
  armed: boolean,
  canControl: boolean,
): ManualControlPresentation {
  const canActuate = armed && canControl && entity.online && entity.phase !== 'pending'
    && (entity.held || (entity.state !== 'fault' && !entity.routeControlled && entity.state !== 'on'));

  let action: ManualControlPresentation['action'];
  if (entity.phase === 'pending') action = 'Sending…';
  else if (!entity.online || entity.state === 'unavailable') action = 'Offline';
  else if (!canControl) action = 'Read only';
  else if (entity.held) action = armed ? 'Release' : 'Held';
  else if (entity.state === 'fault') action = 'Fault';
  else if (entity.routeControlled || entity.state === 'on') action = 'In use';
  else if (!armed) action = 'Locked';
  else if (entity.phase === 'refused' || entity.phase === 'expired') action = 'Retry';
  else action = 'Hold';

  let reported: ManualControlPresentation['reported'];
  if (!entity.online || entity.state === 'unavailable') reported = 'Offline';
  // A release drops the local sustained claim before the POST begins, so `held`
  // is already false while its pending row is rendered. The last reported on
  // state preserves the command direction until the controller confirms off.
  else if (entity.phase === 'pending') reported = entity.held || entity.state === 'on' ? 'Releasing' : 'Starting';
  else if (entity.phase === 'refused') reported = 'Refused';
  else if (entity.phase === 'expired') reported = 'Unconfirmed';
  else if (entity.state === 'fault') reported = 'Fault';
  else if (entity.kind === 'valve') reported = entity.state === 'on' ? 'Open' : entity.state === 'off' ? 'Closed' : 'Unknown';
  else reported = entity.state === 'on' ? 'Running' : entity.state === 'off' ? 'Stopped' : 'Unknown';

  return { canActuate, action, reported };
}
