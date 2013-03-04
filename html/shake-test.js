/*jsl:option explicit*/
"use strict";

function t(a,b,c){return {start:a,stop:b,command:c};}

var dat1 =
    // Haskell depends on Functional, C and Cpp depend on Imperative
    // Exe depends on Haskell/C/Cpp
    [{name:"Functional", built:0, changed:3, depends:[], execution:1, traces:[t(0,1,"gen")]}
    ,{name:"Imperative", built:0, changed:0, depends:[], execution:2, traces:[t(0,1,"gen"),t(1,2,"gen")]}
    ,{name:"HsSource",   built:3, changed:3, depends:[], execution:0}
    ,{name:"Haskell",    built:3, changed:3, depends:[0,2], execution:8, traces:[t(1,8.9,"ghc")]}
    ,{name:"C",          built:0, changed:0, depends:[1], execution:15, traces:[t(2,16.9,"gcc")]}
    ,{name:"Cpp",       built:0, changed:0, depends:[1], execution:10, traces:[t(2,10,"gcc")]}
    ,{name:"Exe",        built:0, changed:0, depends:[3,4,5], execution:5, traces:[t(17,22,"link")]}
    ]


function test() // :: String
{
    function assert(b)
    {
        if (!b) throw "Assertion failed";
    }

    function assertEq(got,want)
    {
        if (want != got)
        {
            console.log("Wanted: " + want);
            console.log("Got: " + got);
            assert(false);
        }
    }

    function assertRegex(want,got)
    {
        if (!(new RegExp(want)).test(got))
        {
            console.log("Wanted: " + want);
            console.log("Got: " + got);
            assert(false);
        }
    }

    var sum1 = summary(dat1);
    var ssum1 = showSummary(sum1);
    console.log(ssum1);
    var want = ["4 runs" ,"7 rules","5 rebuilt","7 traced","6 in","build time is 41.00s","38.80s is traced"
               ,"longest rule takes 15.00s","longest traced command takes 14.90s","parallelism of 1.40","22.00s"];
    assertRegex(want.join(".*"),ssum1.join(" "));

    var tab1 = prepare(sum1, dat1);
    var par1 = commandGraph(tab1,"group('x')",10)['x'];
    console.log(par1);
    var pars1 = par1.map(function(i){return Math.round(i*10)/10;});
    assert(listEq(pars1, [2.1,3,3,3,1.6,1,1,1,1,1]));

    var ans1 = ruleTable(tab1,"");
    console_table(ans1);
    assertEq(ans1.length, 7);
    var ans2 = ruleTable(tab1,"leaf()");
    console_table(ans2);
    assertEq(ans2.length, 3);
    var ans3 = ruleTable(tab1,"name(/^(.)/)");
    console_table(ans3);
    assertEq(ans3.length, 5);
    var ans4 = commandTable(tab1,"");
    console_table(ans4);
    assertEq(ans4.length, 4);
    var ans5 = commandTable(tab1,"command(/g(.*)/)");
    console_table(ans5);
    assertEq(ans5.length, 3);

    return "passed";
}

// Will be available in the latest Chrome, then I can delete this
function console_table(xs)
{
    if (xs.length === 0)
        console.log("No data");
    else
    {
        var widths = [];
        var cells = [];
        for (var i = 0; i <= xs.length; i++)
            cells.push([]);
        for (var s in xs[0])
        {
            var len = s.length;
            cells[0].push(s);
            for (var i = 0; i < xs.length; i++)
            {
                var ss = "" + xs[i][s];
                len = Math.max(len, ss.length);
                cells[i+1].push(ss);
            }
            widths.push(len);
        }
        var s = "";
        for (var x = 0; x < cells.length; x++)
        {
            for (var y = 0; y < widths.length; y++)
                s += "|" + pad(widths[y], cells[x][y]);
            s += "|\n";
        }
        console.log(s);
    }
}

function pad(n,s)
{
    var res = s;
    for (var i = s.length; i < n; i++)
        res += " ";
    return res;
}
