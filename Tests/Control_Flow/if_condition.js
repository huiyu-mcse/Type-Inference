// Complex Test 08: If-else where both branches write to same global object
// "response" is a global object modified in both branches
// C-If requires condition <= bool
// Both branches generate PropWrite constraints on response__global
// Interesting: response ends up needing BOTH {status: ...} and {error: ...}

var response = {};
var ok = true;

function f(ok, response) {
  //var response;
  if (ok) {
    response.status = 200;
    response.body = "success";
    var x = 1;

  } else {
    response.status = 404;
    response.aux = "not found";
  }
}

//出问题了

