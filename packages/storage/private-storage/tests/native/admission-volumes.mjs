/** Select already-mounted local volumes for an authorized bounded, read-only rejection probe. */
export function selectUnsupportedLocalVolumes(volumes) {
  return volumes.filter(volume => volume.metadataAvailable && [2, 3, 5, 6].includes(volume.driveType)
    && !volume.remote && (volume.filesystem !== 'NTFS' || volume.readOnly || !volume.persistentAcls || volume.driveType === 6))
}
