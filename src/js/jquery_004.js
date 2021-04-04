var degree = 0;

function spinout() {


    var $spin = $("#contactform");
    $spin.css({ WebkitTransform: 'rotate(' + degree + 'deg)' });
    $spin.css({ '-moz-transform': 'rotate(' + degree + 'deg)' });
    timer = setTimeout(function () {
        spinout();
        ++degree;
    }, 1);

}

function swallow(strMessage) {

    var $swl = $("#contactfieldset");
    //$swl.css("background", "cream");
    $swl.animate({ width: '100px', height: '100px' }, 5000, function () {
        $swl.css({ position: 'absolute', top: $('#footer').offset().top, left: $('#footer').offset().left })
	    	.animate({ top: $('#footer').offset().top, left: $('#footer').offset().left }, 1000,
	                    function () {
	                        $swl.hide();
	                        $("#tipsFooter").text(strMessage);
	                    }
			);
    });

}

post_form = function (form) {
    $.ajax({
        type: 'POST',
        url: 'form-to-email.php',
        data: $(form).parent().parent().parent().formSerialize(),
        success: function (xml) {
            switch ($("status", xml).text()) {
                case '1':
                    //alert($("message", xml).text());
                    $("#tipsSendMail").text($("message", xml).text());
                    spinout();
                    swallow("Message has been delivered!");
                    break;

                case '2':
                    //alert($("message", xml).text());
                    $("#tipsSendMail").text($("message", xml).text());
                    // Add a red border to the dirty field
                    $("#" + $("field", xml).text()).css('border', '1px solid #dd0000')
					.effect('shake', {}, 'fast').effect('bounce', {}, 'fast', function () {
					    $(this).focus();
					})
					.bind('focus', function () {
					    $(this).css('border', '1px solid #333333');
					    $("#tipsSendMail").text("");
					})
					.bind('blur', function () {
					    $(this).css('border', '1px solid #333333');
					    $("#tipsSendMail").text("");
					});
                    break;

                default:
                    // Something bad happened, and it wasn't a validation error
                    alert($("message", xml).text());
                    break;
            }
        },
        error: function (xml, message) {
            alert('Communication Error');
        }
    });
}
