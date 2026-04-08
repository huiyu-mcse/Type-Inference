var response = {};
var ok = true;

function f(ok, response) {
  //var response;  //global vs scope
  if (ok) {
    response.status = 200;
    response.body = "success";
    var x = 1;

  } else {
    response.status = 404;
    response.aux = "not found";
  }
}

//TODO: global vs local

