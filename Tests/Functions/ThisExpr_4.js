function f() {
    const counter = {
        count: 10,
        getCount: function() {
            return this.count;
        }
    };
}


//const func = counter.getCount;
//console.log(func()); // undefined (因为此时 this 指向全局)

