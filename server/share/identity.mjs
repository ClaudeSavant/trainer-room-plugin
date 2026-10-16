// Bridge-side identity (spec §6): the one place that builds what proves this
// lab to the relay. v1 is "owner key + invite token"; a later GitHub sign-in
// replaces this module without touching the counts protocol.
export function credentials(state) {
  return { labId: state.labId, ownerKey: state.ownerKey };
}

export function registration(state) {
  return {
    ...credentials(state),
    name: state.name,
    public: state.public,
    inviteToken: state.inviteToken,
    publicId: state.publicId,
  };
}
