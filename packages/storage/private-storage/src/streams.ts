/** Forward to the installed root singleton; this entry owns no native resources or capability registry. */
export {
  streamCapabilities, observeProcessBirth, isManagementLeaseBusy, PrivateStorageError, PrivateStreamError,
  PrivateFileWriterError, SourceFileReaderError,
  openPrivateStreamDirectory, openPrivateStreamRoot, PrivateStreamRootError,
  createPrivateFileWriter, openSourceDirectory, openSourceChild, listSourceDirectory,
  inspectSourceFile, inspectSourceLink, openSourceFileReader, openObservedSourceFileReader,
  ObservedSourceFileReaderError, readSourceDocument,
  MAX_STREAM_CHUNK_BYTES, MAX_STREAM_FILE_BYTES, readPrivateRecord, openPrivateFileReader,
  openPrivateStreamChild, createPrivateStreamChild, listPrivateStreamDirectory, inspectPrivateStreamEntry, observePrivateStreamCapacity,
  acquireManagementLease, assertManagementLease, createControlRecordOwner, openPrivateLogSink,
  ControlRecordWriterError, PrivateLogSinkError,
} from '@deepseek-ai/dsh-private-storage'
export type {
  PrivateDirectory, WindowsSourceDirectory, PrivateStreamOperationId, PrivateFileWriter, PrivateFileWriterOptions,
  PrivateFilePublicationReceipt, SourceFileFacts, SourceFileReader, SourceFileReaderOptions, SourceFileReadReceipt,
  StreamIdentity, StreamMechanism, PrivateStreamDirectory, SourceDirectory, ManagementLease,
  PrivateStreamDirectoryFacts, PrivateStreamDirectoryListing,
  PrivateStreamInspectedEntry, PrivateStreamFileFacts, PrivateStreamCapacity, PrivateStreamDirectoryPublication,
  SourceDocumentReadOptions, SourceDocumentReadResult, StreamCapabilities, StreamNativeArtifact,
  ControlRecordOwner, ControlRecordWriterOptions, ControlRecordWriter, ControlRecordReceipt,
  PrivateRecordReadResult, PrivateLogSink, PrivateLogReceipt, ProcessBirthObservation,
  SourceDirectoryFacts, SourceDirectoryEntry, SourceDirectoryListing,
  PrivateStreamRootOpening, PrivateStreamRootReceipt,
  SourceLinkFacts, SourceLinkObservation,
  ObservedSourceFileReader, ObservedSourceFileReaderOptions, ObservedSourceFileReadReceipt,
} from '@deepseek-ai/dsh-private-storage'
