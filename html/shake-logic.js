/*jsl:option explicit*/
"use strict";

// Data
//     {name :: String
//     ,built :: Int
//     ,changed :: Int
//     ,depends :: [Int]
//     ,execution :: Double
//     ,traces :: [Trace]
//     }
//
// Trace
//     {start :: Double
//     ,stop :: Double
//     ,command :: String
//     }


//////////////////////////////////////////////////////////////////////
// UTILITIES

function /* export */ showTime(x) // :: Double -> String
{
    function digits(x){var s = String(x); return s.length === 1 ? "0" + s : s;}

    if (x >= 3600)
    {
        var x = Math.round(x / 60);
        return Math.floor(x / 60) + "h" + digits(x % 60) + "m";
    }
    else if (x >= 60)
    {
        var x = Math.round(x);
        return Math.floor(x / 60) + "m" + digits(x % 60) + "s";
    }
    else
        return x.toFixed(2) + "s";
}

function /* export */ showPerc(x) // :: Double -> String
{
    return (x*100).toFixed(2) + "%";
}

function plural(n,not1,is1) // :: Int -> Maybe String -> Maybe String -> String
{
    return n === 1
        ? (is1 === undefined ? "" : is1)
        : (not1 === undefined ? "s" : not1);
}

function listEq(xs, ys) // :: Eq a => [a] -> [a] -> Bool
{
    if (xs.length !== ys.length) return false;
    for (var i = 0; i < xs.length; i++)
    {
        if (xs[i] !== ys[i])
            return false;
    }
    return true;
}

function cache(str, f) // :: (k -> String) -> (k -> v) -> (k -> v)
{
    var cache = {};
    return function(k){
        var s = str(k);
        if (!(s in cache))
            cache[s] = f(k);
        return cache[s];
    }
}

function bools(x,y)
{
    return x === "" ? y : x === y ? x : "both";
}


//////////////////////////////////////////////////////////////////////
// SUMMARY

function /* export */ summary(dat) // :: Data -> Summary
{
    // Summary statistics
    var res =
        {count : 0 // :: Int, number of rules run
        ,countLast : 0 // :: Int, number of rules run in the last run
        ,highestRun : 0 // :: Int, highest run you have seen (add 1 to get the count of runs)
        ,sumExecution : 0 // :: Seconds, build time in total
        ,maxExecution : 0 // :: Seconds, longest build rule
        ,countTrace : 0, countTraceLast : 0 // :: Int, traced commands run
        ,sumTrace : 0, sumTraceLast : 0 // :: Seconds, time running traced commands
        ,maxTrace : 0 // :: Seconds, longest traced command
        ,maxTraceStopLast : 0 // :: Seconds, time the last traced command stopped
        }

    // Fold over dat to produce the summary
    res.count = dat.length;
    for (var i = 0; i < dat.length; i++)
    {
        var isLast = dat[i].built === 0;
        res.countLast += isLast ? 1 : 0;
        res.sumExecution += dat[i].execution;
        res.maxExecution = Math.max(res.maxExecution, dat[i].execution);
        res.highestRun = Math.max(res.highestRun, dat[i].changed); // changed is always greater or equal to built
        var traces = dat[i].traces;
        if (!traces) continue;
        for (var j = 0; j < traces.length; j++)
        {
            var time = traces[j].stop - traces[j].start;
            res.countTrace += 1;
            res.countTraceLast += isLast ? 1 : 0;
            res.sumTrace += time;
            res.sumTraceLast += isLast ? time : 0;
            res.maxTrace = Math.max(res.maxTrace, time);
            res.maxTraceStopLast = Math.max(res.maxTraceStopLast, isLast ? traces[j].stop : 0);
        }
    }
    return res;
}

function /* export */ showSummary(sum) // Summary -> [String]
{
    return ["This database has tracked " + (sum.highestRun+1) + " run" + plural(sum.highestRun+1) + "."
           ,"There are " + sum.count + " rules (" + sum.countLast + " rebuilt in the last run)."
           ,"Building required " + sum.countTrace + " traced commands (" + sum.countTraceLast + " in the last run)."
           ,"The total (unparallelised) build time is " + showTime(sum.sumExecution) + " of which " + showTime(sum.sumTrace) + " is traced commandsum."
           ,"The longest rule takes " + showTime(sum.maxExecution) + ", and the longest traced command takes " + showTime(sum.maxTrace) + "."
           ,"Last run gave an average parallelism of " + (sum.maxTraceStopLast === 0 ? 0 : sum.sumTraceLast / sum.maxTraceStopLast).toFixed(2) + " times over " + showTime(sum.maxTraceStopLast) + "."
           ];
}


/////////////////////////////////////////////////////////////////////
// PREPARATION

// Mutate the input data, adding in rdeps, being the 1-level reverse dependencies
function addRdeps(dat) // Data -> Mutate Data{+rdeps}
{
    // find the reverse dependencies
    var rdeps = [];
    for (var i = 0; i < dat.length; i++)
        rdeps[i] = {};
    for (var i = 0; i < dat.length; i++)
    {
        var deps = dat[i].depends;
        for (var j = 0, n = deps.length; j < n; j++)
            rdeps[deps[j]][i] = true;
    }
    for (var i = 0; i < rdeps.length; i++)
    {
        var ans = [];
        for (var j in rdeps[i])
            ans.push(Number(j));
        dat[i].rdeps = ans;
    }
}


// Given an array of indices, calculate the cost to rebuild if all of them change
// You must call addRdeps and addCost first
function calcRebuildCosts(dat,xs) // Data{+rdeps+cost} -> [Int] -> Double
{
    var seen = {};
    var tot = 0;
    function f(i)
    {
        if (seen[i]) return;
        seen[i] = true;
        tot += dat[i].execution;
        var deps = dat[i].rdeps;
        for (var j = 0, n = deps.length; j < n; j++)
            f(deps[j]);
    }
    if (xs.length === 1 && dat[xs[0]].depends.length === 1)
        tot = dat[dat[xs[0]].depends[0]].cost + dat[xs[0]].execution;
    else
    {
        for (var i = 0, n = xs.length; i < n; i++)
            f(xs[i]);
    }
    return tot;
}


// Mutate the dat data, adding in cost, being the cost to rebuild if this item changes
function addCost(dat) // Data -> Mutate Data{+cost}
{
    for (var i = 0; i < dat.length; i++)
        dat[i].cost = calcRebuildCosts(dat, [i]);
}

function prepare(sum, dat) // Data -> DataEx
{
    addRdeps(dat);
    addCost(dat);

    function regexSource(r){return r.source;}

    function findDirect(key)
    {
        var c = cache(regexSource, function(r){
            var want = {};
            for (var i = 0; i < dat.length; i++)
            {
                if (r.test(dat[i].name))
                {
                    var deps = dat[i][key];
                    for (var j = 0; j < deps.length; j++)
                        want[deps[j]] = true;
                }
            }
            return want;
        });
        return function(i,r){return i in cache[r];}
    }

    function findTransitive(key, dirFwd)
    {
        return cache(regexSource, function(r){
            var want = {};
            for (var i = 0; i < dat.length; i++)
            {
                var j = dirFwd ? i : dat.length - 1 - i;
                if ((j in want) || r.test(dat[j].name))
                {
                    want[j] = true;
                    var deps = dat[j][key];
                    for (var k = 0; k < deps.length; k++)
                        want[deps[k]] = true;
                }
            }
            return want;
        });
        return function(i,r){return i in cache[r];}
    }

    return {original: dat
           ,summary: sum
           ,dependsOnThis: findDirect("rdeps")
           ,thisDependsOn: findDirect("depends")
           ,dependsOnThisTransitive: findTransitive("depends", false)
           ,thisDependsOnTransitive: findTransitive("rdeps", true)
           }
}


/////////////////////////////////////////////////////////////////////
// RULES

function ruleFilter(dat, query) // DataEx -> Query -> Dict String DataIndex
{
    queryData = dat;
    var f = new Function("return " + (query === "" ? "true" : query));
    var res = {};

    for (var queryKey = 0; queryKey < dat.original.length; queryKey++)
    {
        queryVal = dat.original[queryKey];
        queryGroup = "";
        if (f())
        {
            if (queryGroup === "") queryGroup = queryVal.name;
            if (!(queryGroup in res))
                res[queryGroup] = [queryKey];
            else
                res[queryGroup].push(queryKey);
        }
    }
    return res;
}

function ruleTable(dat, query) // DataEx -> Query -> [Record]
{
    var res = ruleFilter(dat, query);
    var ans = [];
    for (var s in res)
    {
        var xs = res[s];
        var time = 0;
        var leaf = "";
        var unchanged = "";
        var runs = 100000;
        for (var i = 0; i < xs.length; i++)
        {
            var x = dat.original[xs[i]];
            time += x.execution;
            leaf = bools(leaf, x.depends == 0);
            unchanged = bools(unchanged, x.changed !== x.built);
            runs = Math.min(runs,x.built);
        }
        ans.push({name:s, count:xs.length, time:time, cost:calcRebuildCosts(dat.original,xs), leaf:leaf, runs:runs, unchanged:unchanged});
    }
    return ans;
}

function ruleGraph(dat, query) // DataEx -> Query -> [Record]
{
    return [];
}


/////////////////////////////////////////////////////////////////////
// COMMANDS

function commandFilter(dat, query) // DataEx -> Query -> Dict String [Trace]
{
    queryData = dat;
    var f = new Function("return " + (query === "" ? "true" : query));
    var res = {};

    for (var queryKey = 0; queryKey < dat.original.length; queryKey++)
    {
        queryVal = dat.original[queryKey];
        queryGroup = "";
        var val = {};
        for (var s in queryVal)
            val[s] = queryVal[s];
        var ts = queryVal.traces || [];
        queryVal = val;
        for (var i = 0; i < ts.length; i++)
        {
            queryVal.traces = [ts[i]];
            queryGroup = "";
            if (f())
            {
                if (queryGroup === "") queryGroup = ts[i].command;
                if (!(queryGroup in res))
                    res[queryGroup] = [ts[i]];
                else
                    res[queryGroup].push(ts[i]);
            }
        }
    }
    return res;
}

function commandTable(dat, query) // DataEx -> Query -> [Record]
{
    var res = commandFilter(dat, query);
    var ans = [];
    for (var s in res)
    {
        var xs = res[s];
        var time = 0;
        for (var i = 0; i < xs.length; i++)
            time += xs[i].stop - xs[i].start;
        ans.push({command:s, count:xs.length, time:time});
    }
    return ans;
}

function commandGraph(dat, query, buckets) // DataEx -> Query -> Int -> Dict String [Double]
{
    var end = dat.summary.maxTraceStopLast;
    var res = commandFilter(dat, query);
    var ans = {};
    for (var s in res)
    {
        var ts = res[s];
        console.log("ts");
        console.log(ts);
        var xs = [];
        for (var i = 0; i <= buckets; i++)
            xs.push(0); // fill with 1 more element, but the last bucket will always be 0

        for (var i = 0; i < ts.length; i++)
        {
            var start = ts[i].start * buckets / end;
            var stop = ts[i].stop * buckets / end;

            if (Math.floor(start) === Math.floor(stop))
                xs[Math.floor(start)] += stop - start;
            else
            {
                for (var j = Math.ceil(start); j < Math.floor(stop); j++)
                    xs[j]++;
                xs[Math.floor(start)] += Math.ceil(start) - start;
                xs[Math.floor(stop)] += stop - Math.floor(stop);
            }
        }
        console.log(xs);
        ans[s] = xs.slice(0,buckets);
    }
    return ans;
}


/////////////////////////////////////////////////////////////////////
// ENVIRONMENT

// These are global variables mutated/queried by query execution
var queryData = {};
var queryKey = 0;
var queryVal = {};
var queryGroup = "";

function dependsOnThis(r){queryData.dependsOnThis(queryKey, r);}
function thisDependsOn(r){queryData.thisDependsOn(queryKey, r);}
function dependsOnThisTransitive(r){queryData.dependsOnThisTransitive(queryKey, r);}
function thisDependsOnTransitive(r){queryData.thisDependsOnTransitive(queryKey, r);}

function /* export */ group(x)
{
    queryGroup += (queryGroup === "" ? "" : " ") + x;
    return true;
}

function /* export */ leaf()
{
    return queryVal.depends.length === 0;
}

function /* export */ run()
{
    return queryVal.built;
}

function /* export */ unchanged()
{
    return queryVal.changed !== queryVal.built;
}

function /* export */ name(r)
{
    if (r === undefined)
        return queryVal.name;
    var res = r.exec(queryVal.name);
    if (res === null)
        return false;
    if (res.length !== 1)
    {
        for (var i = 1; i < res.length; i++)
            group(res[i]);
    }
    return true;
}

function /* export */ command(r)
{
    var n = queryVal.traces.length;
    if (r === undefined)
        return n === 0 ? "" : queryVal.traces[0].command;

    for (var i = 0; i < n; i++)
    {
        var res = r.exec(queryVal.traces[i].command);
        if (res === null)
            continue;
        if (res.length !== 1)
        {
            for (var j = 1; j < res.length; j++)
                group(res[j]);
        }
        return true;
    }
    return false;
}
