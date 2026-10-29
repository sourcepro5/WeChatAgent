// Capability/version selection, not permission to apply one version's offsets to another.
export const hookProfiles=Object.freeze({
  '4.1.10.27':Object.freeze({loader:'version-proxy',nativeText:true,nativeSticker:true}),
  '4.1.15.13':Object.freeze({loader:'explicit-text',nativeText:true,nativeImageApi:true,nativeMentionApi:true,nativeSticker:false}),
});
export const hookProfile=version=>hookProfiles[version]??null;
