
module Test.Resources(main) where

import Development.Shake
import Test.Type
import Control.Monad
import Data.IORef


main extra = do
    inside <- newIORef 0
    done <- newIORef 0
    flip (shaken test) extra $ \args obj -> do
        want args

        let cap = 2
        r1_cap <- newResource "test" cap
        r2_cap <- newResource "test" cap
        unless (r1_cap < r2_cap || r2_cap < r1_cap) $ error "Resources should have a good ordering"

        phony "cap" $
            need $ map obj ["file1.txt","file2.txt","file3.txt","file4.txt"]
        obj "*.txt" %> \out ->
            withResource r1_cap 1 $ do
                old <- liftIO $ atomicModifyIORef inside $ \i -> (i+1,i)
                when (old >= cap) $ error "Too many resources in use at one time"
                liftIO $ sleep 0.1
                liftIO $ atomicModifyIORef inside $ \i -> (i-1,i)
                writeFile' out ""

        lock <- newResource "lock" 1
        phony "schedule" $ do
            need $ map obj $ "lock1":"done":["free" ++ show i | i <- [1..10]] ++ ["lock2"]
        obj "done" %> \out -> do
            need [obj "lock1",obj "lock2"]
            done <- liftIO $ readIORef done
            when (done < 10) $ error "Not all managed to schedule while waiting"
            writeFile' out ""
        obj "lock*" %> \out -> do
            withResource lock 1 $ liftIO $ sleep 0.5
            writeFile' out ""
        obj "free*" %> \out -> do
            liftIO $ atomicModifyIORef done $ \i -> (i+1,())
            writeFile' out ""


test build obj = do
    build ["-j2","cap","--clean"]
    build ["-j4","cap","--clean"]
    build ["-j10","cap","--clean"]
    build ["-j2","schedule","--clean"]
