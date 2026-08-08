/*
 * Kyryll Tenin Baum 2014
*/
(function ($) {

    var kyryll = {
	
        init: function () {
			
			$("body").show();
			
			    	//alert($("#HTTP_REFERER").text());
    	
    	var term = $("#REQUEST_URI").text();
    	if (term) term = term.substring(1);
    	
    		//alert("Starting");
		$.ajax({
		        type: 'POST',
		        url: 'dictionary.php',
		        data: {word: term, ref: "collegiate", key: "b0172bd9-d86d-48a3-aad6-d19aa63241c2"},
		        success: function (xml) {
		            //alert($("entry", xml).length);
		            for (var i = 0; i < $("entry", xml).length; i++) {
		            	if (i == 0) {
		            		$("#loading-splash div.loading-splash-center p.loading-term").html("<span class='loading-term'>" + $($("entry", xml)[i]).find("ew").text() + "</span>&nbsp|&nbsp" + $($("entry", xml)[i]).find("pr").contents().filter(function(){return this.nodeType == 3;})[0].nodeValue + "&nbsp|&nbsp");
		            		
		            		$("#loading-splash div.loading-splash-center p.loading-definition").first().text("[" + $($("entry", xml)[i]).find("fl").first().text() + "] : " + 
		            		($('sx', $($("entry", xml)[i]).find("dt").first()).length ?
		            		$('sx', $($("entry", xml)[i]).find("dt").first()).map(function(){return $(this).text();}).get().join(', ') :
		            		$($("entry", xml)[i]).find("dt").first().text().replace(/:/g,""))
		            		);
		            		
		            		$("#loading-splash div.loading-splash-center p.loading-definition").last().html($($("entry", xml)[i]).find("vi").map(function(){return $(this).text();}).get().join(', '));
		            	} else {
		            		
		            	}
		            }
		            
		            $("p.loading-term").cooltext({
				sequence:[
      				{action:"animation", animation:"cool24"}
	  			],
	  			onComplete:function(value){
		  			$("p.loading-definition").first().cooltext({
						sequence:[
		      				{action:"animation", animation:"cool37"}
			  			],
			  			onComplete:function(value){
				  			$("p.loading-definition").last().cooltext({
								sequence:[
				      				{action:"animation", animation:"cool37"}
					  			],
					  			onComplete:function(value){
						  			
									//var sound = new Howl({
									//				urls: ['sound/odessa.mp3']
									//			}).play();
																								
									setTimeout(function () {
	
									}, 3000);
								},
				   			});
						},
		   			});
				}
   			});
		        },
		        error: function (xml, message) {
		            alert('Communication Error');
		        }
		    });
        }
    };

    $(document).ready(function () {
    	// Mutex "kyryllFontsLoaded" is declared in util.js and is called once all the fonts have been loaded
    	kyryllFontsLoaded.add(function()
		{
			kyryll.init();
		});
	});
})(jQuery);