{-# LANGUAGE ScopedTypeVariables, RecordWildCards, FlexibleInstances #-}
{-# LANGUAGE BangPatterns #-}
{-
This module stores the meta-data so its very important its always accurate
We can't rely on getting any exceptions or termination at the end, so we'd better write out a journal
We store a series of records, and if they contain twice as many records as needed, we compact
-}

module Development.Shake.Internal.Core.Storage(
    withStorage
    ) where

import General.Chunks
import General.Binary
import General.Intern
import Development.Shake.Internal.Options
import General.Timing
import General.FileLock
import qualified General.Ids as Ids

import Control.Exception.Extra
import Control.Monad.Extra
import Data.Monoid
import Data.Either.Extra
import Data.Time
import Data.Char
import Data.Word
import Development.Shake.Classes
import Numeric
import General.Extra
import Data.List.Extra
import Data.Maybe
import System.FilePath
import qualified Data.ByteString.UTF8 as UTF8
import qualified Data.HashMap.Strict as Map

import qualified Data.ByteString.Char8 as BS
import qualified Data.ByteString as BS8
import Data.Functor
import Prelude


-- Increment every time the on-disk format/semantics change,
-- @x@ is for the users version number
databaseVersion :: String -> String
-- THINGS I WANT TO DO ON THE NEXT CHANGE
-- * Change filepaths to store a 1 byte prefix saying 8bit ASCII or UTF8
-- * Duration and Time should be stored as number of 1/10000th seconds Int32
databaseVersion x = "SHAKE-DATABASE-14-" ++ s ++ "\r\n"
    where s = tail $ init $ show x -- call show, then take off the leading/trailing quotes
                                   -- ensures we do not get \r or \n in the user portion


messageCorrupt :: FilePath -> SomeException -> IO [String]
messageCorrupt dbfile err = do
    msg <- showException err
    return $
        ("Error when reading Shake database " ++ dbfile) :
        map ("  "++) (lines msg) ++
        ["All files will be rebuilt"]


messageDatabaseVersionChange :: FilePath -> BS.ByteString -> BS.ByteString -> [String]
messageDatabaseVersionChange dbfile old new =
    ["Shake database version changed (either shake library version, or shakeVersion):"
    ,"  File:         " ++ dbfile
    ,"  Old version:  " ++ disp (limit $ BS.unpack old)
    ,"  New version:  " ++ disp (BS.unpack new)
    ,"All rules will be rebuilt"]
    where
        limit x = let (a,b) = splitAt 200 x in a ++ (if null b then "" else "...")
        disp = map (\x -> if isPrint x && isAscii x then x else '?') . takeWhile (`notElem` "\r\n")


-- | Storage of heterogeneous things. In the particular case of Shake,
--   k ~ TypeRep, v ~ (Key, Status{Value}).
--
--   The storage starts with a witness table saying what can be contained.
--   If any entries in the witness table don't have a current Witness then a fake
--   error witness is manufactured. If the witness ever changes the entire DB is
--   rewritten.
withStorage
    :: (Show k, Eq k, Hashable k, NFData k, Show v, NFData v)
    => ShakeOptions                                    -- ^ Storage options
    -> (IO String -> IO ())                            -- ^ Logging function
    -> Map.HashMap k (Ver, BinaryOp v)                 -- ^ Witnesses
    -> (Ids.Ids v -> (k -> Id -> v -> IO ()) -> IO a)  -- ^ Execute
    -> IO a
withStorage ShakeOptions{..} diagnostic witness act = withLockFileDiagnostic diagnostic (shakeFiles </> ".shake.lock") $ do
    let dbfile = shakeFiles </> ".shake.database"
    createDirectoryRecursive shakeFiles

    -- complete a partially failed compress
    whenM (restoreChunksBackup dbfile) $ do
        unexpected "Backup file exists, restoring over the previous file\n"
        diagnostic $ return "Backup file move to original"

    addTiming "Database read"
    withChunks dbfile shakeFlush $ \h -> do

        let corrupt
                | not shakeStorageLog = resetChunksCorrupt Nothing h
                | otherwise = do
                    let file = dbfile <.> "corrupt"
                    resetChunksCorrupt (Just file) h
                    unexpected $ "Backup of corrupted file stored at " ++ file ++ "\n"

        -- check the version information matches
        let ver = BS.pack $ databaseVersion shakeVersion
        oldVer <- readChunkMax h $ fromIntegral $ BS.length ver + 100000
        let verEq = Right ver == oldVer
        when (not shakeVersionIgnore && not verEq && oldVer /= Left BS.empty) $ do
            outputErr $ messageDatabaseVersionChange dbfile (fromEither oldVer) ver
            corrupt

        let (witnessNew, save) = saveWitness witness
        evaluate save
        witnessOld <- readChunk h
        ids <- case witnessOld of
            Left _ -> do
                resetChunksCorrupt Nothing h
                return Nothing
            Right witnessOld ->  handleBool (not . isAsyncException) (\err -> do
                outputErr =<< messageCorrupt dbfile err
                corrupt
                return Nothing) $ do

                (_, load) <- evaluate $ loadWitness witness witnessOld
                ids <- Ids.empty
                let go !i = do
                        v <- readChunk h
                        case v of
                            Left e -> do
                                let slop = fromIntegral $ BS.length e
                                when (slop > 0) $ unexpected $ "Last " ++ show slop ++ " bytes do not form a whole record\n"
                                diagnostic $ return $ "Read " ++ show i ++ " chunks, plus " ++ show slop ++ " slop"
                                return i
                            Right bs -> do
                                let Just (k,id,v) = load bs
                                evaluate $ rnf k
                                evaluate $ rnf v
                                Ids.insert ids id (k,v)
                                diagnostic $ do
                                    let raw x = "[len " ++ show (BS.length bs) ++ "] " ++ concat
                                                [['0' | length c == 1] ++ c | x <- BS8.unpack bs, let c = showHex x ""]
                                    let pretty (Left x) = "FAILURE: " ++ show x
                                        pretty (Right x) = x
                                    x2 <- try_ $ evaluate $ let s = show v in rnf s `seq` s
                                    return $ "Chunk " ++ show i ++ " " ++ raw bs ++ " " ++ show id ++ " = " ++ pretty x2
                                go $ i+1
                countItems <- go 0
                countDistinct <- Ids.sizeUpperBound ids
                diagnostic $ return $ "Found at most " ++ show countDistinct ++ " distinct entries out of " ++ show countItems

                when (countItems > countDistinct*2 || not verEq || witnessOld /= witnessNew) $ do
                    addTiming "Database compression"
                    resetChunksCompact h $ \out -> do
                        out $ putEx ver
                        out $ putEx witnessNew
                        Ids.forWithKeyM_ ids $ \i (k,v) -> out $ save k i v
                Just <$> Ids.for ids snd

        ids <- case ids of
            Just ids -> return ids
            Nothing -> do
                writeChunk h $ putEx ver
                writeChunk h $ putEx witnessNew
                Ids.empty

        addTiming "With database"
        writeChunks h $ \out ->
            act ids $ \k i v ->
                out $ save k i v
    where
        unexpected x = when shakeStorageLog $ do
            t <- getCurrentTime
            appendFile (shakeFiles </> ".shake.storage.log") $ "\n[" ++ show t ++ "]: " ++ trimEnd x ++ "\n"
        outputErr x = do
            when (shakeVerbosity >= Quiet) $ shakeOutput Quiet $ unlines x
            unexpected $ unlines x


keyName :: Show k => Ver -> k -> BS.ByteString
keyName (Ver v) k = UTF8.fromString $ show v ++ " " ++ show k

type Witness = BS.ByteString

loadWitness :: Show k => Map.HashMap k (Ver, BinaryOp v) -> Witness -> ([String], BS.ByteString -> Maybe (k, Id, v))
loadWitness mp bs = ind `seq` mp2 `seq` ([], \bs ->
            let (k :: Word16, bs2) = binarySplit bs
            in case ind (fromIntegral k) of
                    Nothing -> error $ "Witness type out of bounds, " ++ show k
                    Just f -> f bs2)
    where
        ws :: [BS.ByteString] = getEx bs
        mp2 = Map.fromList [(keyName ver k, (k, v)) | (k,(ver,v)) <- Map.toList mp]
        ind = fastAt [ case Map.lookup w mp2 of
                            Nothing -> const Nothing
                            Just (k, BinaryOp{..}) -> \bs ->
                                let (i, bs2) = binarySplit bs
                                    v = getOp bs2
                                in Just (k, i, v)
                     | w <- ws]


saveWitness :: (Eq k, Hashable k, Show k) => Map.HashMap k (Ver, BinaryOp v) -> (Witness, k -> Id -> v -> Builder)
saveWitness mp
    | Map.size mp > fromIntegral (maxBound :: Word16) = error "Number of distinct witness types exceeds limit"
    | otherwise = (runBuilder $ putEx (ws :: [BS.ByteString]), mp2 `seq` \k -> fromMaybe (error $ "Don't know how to save, " ++ show k) $ Map.lookup k mp2)
    where
        ws = sort $ map (\(k,(ver,_)) -> keyName ver k) $ Map.toList mp
        wsMp = Map.fromList $ zip ws [0 :: Word16 ..]
        mp2 = Map.mapWithKey (\k (ver,BinaryOp{..}) -> let tag = putEx $ wsMp Map.! keyName ver k in \(Id w) v -> tag <> putEx w <> putOp v) mp


withLockFileDiagnostic :: (IO String -> IO ()) -> FilePath -> IO a -> IO a
withLockFileDiagnostic diagnostic file act = do
    diagnostic $ return $ "Before withLockFile on " ++ file
    res <- withLockFile file $ do
        diagnostic $ return "Inside withLockFile"
        act
    diagnostic $ return "After withLockFile"
    return res
